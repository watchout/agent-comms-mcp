import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { EventLog, ensureEventLogSchema, frozenEnabledSetSha256, runtimeSnapshotSha256 } from '../../core/eventlog'
import { v2Send } from '../../core/eventlog/window'
import { bunInvoker, type HeadlessInvoker } from '../../core/eventlog/runtimes'
import { internalLoop, internalLoopTick } from '../../bin/aun/v2-internal-loop'

let db: SqliteAdapter, dir: string, o: Parameters<typeof internalLoopTick>[1]
const h = 'a'.repeat(40), digest = 'b'.repeat(64)
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'm9-test-')); db = new SqliteAdapter(join(dir, 'db')); await ensureEventLogSchema(db)
  const bindings = ['alpha', 'beta'].map(agent_id => ({ agent_id, runtime_instance_id: agent_id, workspace_realpath: dir,
    active_function: 'evidence_audit_gate', memory_project: agent_id, model_adapter: 'codex' as const, sandbox_profile: 'read-only',
    allowed_tools: ['apply_patch', 'exec_command'], allowed_env_keys: ['PATH'], policy_digest: digest, authority_snapshot_digest: digest,
    build_sha: h, tree_hash: h, config_digest: digest }))
  const agents = bindings.map(b => ({ agent_id: b.agent_id, profile_revision: '1', runtime_engine: b.model_adapter,
    runtime_instance_id: b.runtime_instance_id, runtime_checkout_root: b.workspace_realpath, runtime_checkout_sha: b.build_sha }))
  const scope = { schema_version: 'aun-v2-native-mesh-scope/v1', run_id: 'm9', stage_id: 'S0_IMPLEMENTATION', repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: h, database_identity: `sqlite:${join(dir, 'db')}`, frozen_enabled_set: agents,
    frozen_enabled_set_sha256: frozenEnabledSetSha256(agents), runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
    provider_dispatch: 'disabled', V1_mode: 'observe_only_no_traversal', deadline_ms: Date.now() + 60000 }
  o = { scope, fence: { stage_id: 'S0_IMPLEMENTATION', exact_implementation_head: h, database_identity: scope.database_identity,
    runtime_snapshot_sha256: scope.runtime_snapshot_sha256 }, bindings: [bindings[1]], current: b => b, timeoutMs: 25,
    schemaPath: join(dir, 'schema'), dispatcherInstanceId: 'm9-dispatcher', predecessorDeathEvidenceEventIds: {}, parentEnv: {} }
})
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }) })
const seed = () => v2Send(db, { agentId: 'alpha', scope: o.scope, fence: o.fence, nowMs: Date.now() }, {
  to: 'beta', conversation_id: null, idempotency_key: 'm9', content: 'independent fixture audit',
  refs: { principal_ref: 'p', pack_digest: 'd', approval_ref: 'a', onza_run_id: 'run' } })
const events = () => db.query<{ event_type: string; payload: string; seat_id: string }>('SELECT event_type, payload, seat_id FROM event_log ORDER BY seq')
test('one tick emits the complete native receive/link/worker/handoff sequence, no legacy delivery', async () => {
  await seed()
  const invoker: HeadlessInvoker = { run: async (cmd, options) => {
    expect(cmd.slice(0, 2)).toEqual(['codex', 'exec']); expect(options?.timeoutMs).toBe(25)
    expect(options?.allowedTools).toEqual(['apply_patch', 'exec_command']); expect(options?.sandboxProfile).toBe('read-only')
    return { exitCode: 0, stdout: '{"ok":true,"outcome":"replied","reply":"fixture gate result"}', stderr: '' }
  } }
  const result = await internalLoopTick(db, { ...o, invoker })
  expect(result).toMatchObject({ ok: true, accepted: 1, ignoredExternal: 0 })
  const rows = await events()
  expect(rows.map(r => r.event_type)).toEqual(['message.received', 'conversation.linked', 'turn.claimed', 'turn.presented',
    'turn.completed', 'reply.enqueued', 'reply.delivery_claimed', 'message.received', 'reply.handoff_accepted'])
  expect(JSON.parse(rows[0].payload).mesh_native).toBe(true); expect(rows.filter(r => r.event_type === 'message.received')[1].seat_id).toBe('alpha')
  expect((await internalLoopTick(db, { ...o, invoker })).accepted).toBe(0)
  console.log(JSON.stringify({ fixture_provider: true, execution: rows, result }))
})
test('mismatched fence and binding have zero effects and zero invocations', async () => {
  await seed(); let calls = 0
  const invoker = { run: async () => { calls++; throw Error('must not invoke') } }
  await expect(internalLoopTick(db, { ...o, invoker, fence: { ...o.fence, exact_implementation_head: 'c'.repeat(40) } })).rejects.toThrow()
  await expect(internalLoopTick(db, { ...o, invoker, current: b => ({ ...b, runtime_instance_id: 'drift' }) })).rejects.toThrow()
  expect(calls).toBe(0); expect(await new EventLog(db).count()).toBe(2)
})
test('real child timeout records failed, preserves inbound for manual fallback, and halts without fabricated reply', async () => {
  await seed()
  const invoker: HeadlessInvoker = { run: (_, options) => bunInvoker.run([process.execPath, '-e', 'await Bun.sleep(10000)'], options) }
  const output: unknown[] = []
  expect(await internalLoop(() => internalLoopTick(db, { ...o, invoker }), false, 1, r => output.push(r))).toBe(1)
  expect(output).toHaveLength(1); expect(output[0]).toMatchObject({ blocking: true, reason: 'manual_handoff', accepted: 0 })
  const rows = await events(), terminal = rows.find(r => r.event_type === 'turn.completed')!
  expect(JSON.parse(terminal.payload)).toMatchObject({ outcome: 'failed' })
  expect(JSON.parse(rows[0].payload).content).toBe('independent fixture audit')
  expect(rows.some(r => r.event_type.startsWith('reply.'))).toBe(false)
  expect((await internalLoopTick(db, { ...o, invoker })).seats[0].claimed).toBe(0)
})
test('three consecutive idle ticks stop; no sleep or tick after halt', async () => {
  let ticks = 0, sleeps = 0
  expect(await internalLoop(async () => { ticks++; return { ok: true, blocking: false, seats: [], accepted: 0, ignoredExternal: 0 } }, false, 1, () => {}, async () => { sleeps++ })).toBe(1)
  expect(ticks).toBe(3); expect(sleeps).toBe(2)
})
test('foreign inbound is rejected before claim', async () => {
  await seed(); let calls = 0
  const invoker = { run: async () => { calls++; throw Error('must not invoke') } }
  await new EventLog(db).append({ eventId: 'foreign', eventType: 'message.received', seatId: 'outside', payload: {} })
  await expect(internalLoopTick(db, { ...o, invoker })).rejects.toThrow()
  expect(calls).toBe(0); expect(await new EventLog(db).count()).toBe(3)
})
test('Codex tool binding outside the two admitted tools is rejected, without invoking the child', async () => {
  await seed(); let calls = 0
  const bindings = o.bindings.map(b => ({ ...b, allowed_tools: ['exec_command', 'web_search'] }))
  const invoker = { run: async () => { calls++; throw Error('must not invoke') } }
  const result = await internalLoopTick(db, { ...o, bindings, invoker })
  expect(result).toMatchObject({ ok: false, blocking: true, reason: 'manual_handoff' }); expect(calls).toBe(0)
  expect((await events()).some(r => r.event_type.startsWith('reply.'))).toBe(false)
})
test('CLI --once rejects a mismatched scope before any DB event mutation', async () => {
  const sf = join(dir, 'scope.json'), bf = join(dir, 'bindings.json')
  writeFileSync(sf, JSON.stringify(o.scope)); writeFileSync(bf, JSON.stringify(o.bindings))
  const child = Bun.spawnSync([process.execPath, '--no-env-file', new URL('../../bin/aun/v2-internal-loop.ts', import.meta.url).pathname,
    '--scope-file', sf, '--seats', bf, '--expected-head', 'c'.repeat(40), '--database-identity', o.fence.database_identity,
    '--runtime-snapshot-sha256', o.fence.runtime_snapshot_sha256, '--timeout-ms', '25', '--once'], { env: { HOME: dir, PATH: '/usr/bin:/bin' } })
  expect(child.exitCode).toBe(1); expect(JSON.parse(child.stderr.toString()).error).toContain('head drift')
  expect(await new EventLog(db).count()).toBe(0)
})
