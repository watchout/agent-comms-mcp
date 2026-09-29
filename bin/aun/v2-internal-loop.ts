// M9: --scope-file scope.json --expected-head SHA --database-identity sqlite:/absolute/db
// --runtime-snapshot-sha256 HASH --seats bindings.json --timeout-ms MEASURED --once
// Or --interval-ms N; bindings.json is ResolvedRuntimeBindingV1[]. No timeout default.
import { readFileSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import { assertV2NativeMeshExecutionFence, decodeV2NativeInboundPayload, v2NativeMeshScopeSha256, type V2NativeMeshExecutionFence } from '../../core/eventlog/v2-native-ingress'
import { recoverSeat, runSeatWorkerOnce } from '../../core/eventlog/worker'
import { recoverV2NativeInternalHandoffClaims, dispatchV2NativeInternalHandoffs } from '../../core/eventlog/internal-handoff'
import { resolveRuntimeBinding, type ResolvedRuntimeBindingV1, type RuntimeBindingCurrentSnapshotV1 } from '../../core/eventlog/runtime-binding'
import { runtimeForBinding, V2_TURN_RESULT_SCHEMA, type HeadlessInvoker } from '../../core/eventlog/runtimes'

type Options = {
  scope: unknown; fence: V2NativeMeshExecutionFence; bindings: ResolvedRuntimeBindingV1[]
  current: (binding: ResolvedRuntimeBindingV1) => RuntimeBindingCurrentSnapshotV1
  timeoutMs: number; schemaPath: string; dispatcherInstanceId: string
  predecessorDeathEvidenceEventIds: Record<string, string>; invoker?: HeadlessInvoker
  parentEnv: Record<string, string | undefined>
}
export async function internalLoopTick(db: DbAdapter, o: Options) {
  const check = () => {
    const scope = assertV2NativeMeshExecutionFence(o.scope, o.fence)
    if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs <= 0) throw Error('explicit measured timeoutMs required')
    if (!o.bindings.length || new Set(o.bindings.map(b => b.agent_id)).size !== o.bindings.length) throw Error('invalid seats')
    for (const binding of o.bindings) {
      const b = resolveRuntimeBinding({ binding, current: o.current(binding) })
      const seat = scope.frozen_enabled_set.find(a => a.agent_id === b.agent_id)
      if (!seat || seat.runtime_instance_id !== b.runtime_instance_id || seat.runtime_engine !== b.model_adapter ||
          seat.runtime_checkout_root !== b.workspace_realpath || seat.runtime_checkout_sha !== b.build_sha) throw Error('seat binding differs from scope')
    }
  }
  check() // Complete preflight before recovery, claims or child invocation.
  for (const row of await db.query<{ payload: string }>("SELECT payload FROM event_log WHERE event_type = 'message.received'")) {
    const p = decodeV2NativeInboundPayload(JSON.parse(row.payload))
    if (p.scope_sha256 !== v2NativeMeshScopeSha256(assertV2NativeMeshExecutionFence(o.scope, o.fence))) throw Error('foreign inbound scope')
  }
  await recoverV2NativeInternalHandoffClaims(db, o.scope, o.fence, { activeInstanceId: o.dispatcherInstanceId, predecessorDeathEvidenceEventIds: o.predecessorDeathEvidenceEventIds })
  for (const b of o.bindings) { check(); await recoverSeat(db, { seatId: b.agent_id, seatInstanceId: b.runtime_instance_id }) }
  const seats = []
  for (const b of o.bindings) {
    check()
    const result = await runSeatWorkerOnce(db, { seatId: b.agent_id, seatInstanceId: b.runtime_instance_id, maxTurns: 1,
      runtime: runtimeForBinding(b, { db, schemaPath: o.schemaPath, timeoutMs: o.timeoutMs, invoker: o.invoker, parentEnv: o.parentEnv }),
      runtimeBinding: b, currentRuntimeBinding: () => o.current(b), mutationFence: check })
    seats.push({ seat: b.agent_id, ...result })
    if (result.failed) return { ok: false, blocking: true, reason: 'manual_handoff', seats, accepted: 0, ignoredExternal: null }
  }
  check()
  const handoff = await dispatchV2NativeInternalHandoffs(db, o.scope, o.fence, { dispatcherInstanceId: o.dispatcherInstanceId })
  return { ok: true, blocking: false, seats, accepted: handoff.accepted.length, ignoredExternal: handoff.ignoredExternal.length }
}
export async function internalLoop(run: () => ReturnType<typeof internalLoopTick>, once: boolean, intervalMs: number, emit: (r: unknown) => void, sleep = Bun.sleep) {
  let stalled = 0
  for (;;) {
    const r = await run(); emit(r)
    if (r.blocking) return 1
    stalled = r.accepted + r.seats.reduce((n, s) => n + s.completed, 0) > 0 ? 0 : stalled + 1
    if (once) return stalled ? 1 : 0
    if (stalled >= 3) { emit({ ok: false, blocking: true, reason: 'no_progress', ticks: stalled }); return 1 }
    await sleep(intervalMs)
  }
}
if (import.meta.main) {
  let db: SqliteAdapter | undefined, temporary: string | undefined
  try {
    const names = ['scope-file', 'expected-head', 'database-identity', 'runtime-snapshot-sha256', 'seats', 'timeout-ms', 'interval-ms', 'death-evidence-file']
    const { values: a } = parseArgs({ args: process.argv.slice(2), options: { ...Object.fromEntries(names.map(n => [n, { type: 'string' as const }])), once: { type: 'boolean' } }, strict: true })
    const required = (name: string) => { const v = a[name]; if (typeof v !== 'string' || !v) throw Error(`--${name} required`); return v }
    const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
    const scope = load(required('scope-file')), bindings: ResolvedRuntimeBindingV1[] = load(required('seats'))
    const fence: V2NativeMeshExecutionFence = { stage_id: 'S0_IMPLEMENTATION', exact_implementation_head: required('expected-head'), database_identity: required('database-identity'), runtime_snapshot_sha256: required('runtime-snapshot-sha256') }
    assertV2NativeMeshExecutionFence(scope, fence)
    if (git(resolve(import.meta.dir, '../..'), 'status', '--porcelain') || git(resolve(import.meta.dir, '../..'), 'rev-parse', 'HEAD') !== fence.exact_implementation_head) throw Error('implementation HEAD differs')
    const dbPath = fence.database_identity.replace(/^sqlite:/, '')
    if (fence.database_identity !== `sqlite:${realpathSync(dbPath)}`) throw Error('database identity must be sqlite:<existing realpath>')
    const timeoutMs = Number(required('timeout-ms')), once = a.once === true, intervalMs = once ? 0 : Number(required('interval-ms'))
    if ((once && a['interval-ms']) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(intervalMs) || (!once && intervalMs <= 0)) throw Error('invalid mode or budget')
    const current = (b: ResolvedRuntimeBindingV1) => {
      const latest = (load(required('seats')) as ResolvedRuntimeBindingV1[]).find(x => x.agent_id === b.agent_id)
      if (!latest) throw Error('binding disappeared')
      return { ...latest, workspace_realpath: realpathSync(latest.workspace_realpath), build_sha: git(latest.workspace_realpath, 'rev-parse', 'HEAD'), tree_hash: git(latest.workspace_realpath, 'rev-parse', 'HEAD^{tree}'), checkout_dirty: git(latest.workspace_realpath, 'status', '--porcelain').length > 0 }
    }
    for (const b of bindings) resolveRuntimeBinding({ binding: b, current: current(b) })
    temporary = mkdtempSync(join(tmpdir(), 'aun-m9-')); const schemaPath = join(temporary, 'result.schema.json')
    writeFileSync(schemaPath, JSON.stringify(V2_TURN_RESULT_SCHEMA))
    db = new SqliteAdapter(dbPath, { create: false })
    const o = { scope, fence, bindings, current, timeoutMs, schemaPath, dispatcherInstanceId: randomUUID(), parentEnv: process.env,
      predecessorDeathEvidenceEventIds: a['death-evidence-file'] ? load(String(a['death-evidence-file'])) : {} }
    process.exitCode = await internalLoop(() => internalLoopTick(db!, o), once, intervalMs, r => console.log(JSON.stringify(r)))
  } catch (error) { console.error(JSON.stringify({ ok: false, blocking: true, error: String(error) })); process.exitCode = 1 }
  finally { await db?.close(); if (temporary) rmSync(temporary, { recursive: true, force: true }) }
}
