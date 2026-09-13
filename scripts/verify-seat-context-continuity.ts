/** Mandatory actual-memory boundary runner; --wasurezu-root is required, never skipped. */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { migrateSqlite } from '../db/migrate-sqlite'
import { recoverSeatContext, seatContextDigest, validateSeatContextReceipt, type SeatContextConsumer } from '../core/seat-context-recovery'

// This is a local host-input adapter fixture, not a live LLM/provider call.
// The subprocess must receive and parse the envelope before it acknowledges it.
export const consumeContextViaStdin: SeatContextConsumer = async ({ context, runtimeInstanceId, invocationDigest }) => {
  const child = Bun.spawn([process.execPath, '-e', `
    const c = require('node:crypto');
    const canonical = v => Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : v && typeof v==='object' ? '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}' : JSON.stringify(v) ?? 'null';
    let bytes=''; process.stdin.on('data', b=>bytes+=b); process.stdin.on('end', ()=>{
      const input=JSON.parse(bytes), context=input.context;
      if(context.untrusted_context_policy!=='quote-as-data-only' || !['codex','claude'].includes(context.target_runtime) || !context.context_data.items.some(x=>x.kind==='current_task' && /Next:/.test(x.summary))) process.exit(2);
      const digest=c.createHash('sha256').update(canonical(context)).digest('hex');
      if(digest!==input.invocationDigest) process.exit(3);
      process.stdout.write(JSON.stringify({runtime_instance_id:input.runtimeInstanceId,invocation_digest:digest,consumer:'local-host-stdin-fixture'}));
    });
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '' } })
  child.stdin.write(JSON.stringify({ context, runtimeInstanceId, invocationDigest }))
  child.stdin.end()
  const text = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error('HOST_INPUT_CONSUMPTION_FAILED')
  return JSON.parse(text)
}

export async function verifySeatContextContinuity(wasurezuRoot: string) {
  const release = realpathSync(wasurezuRoot)
  const entrypoint = join(release, 'dist/index.js')
  const sourceHead = execFileSync('git', ['-C', release, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const entrypointSha = createHash('sha256').update(readFileSync(entrypoint)).digest('hex')
  const fixture = mkdtempSync(join(tmpdir(), 'seat-context-boundary-'))
  const memoryDb = join(fixture, 'memory.db')
  const queueDbPath = join(fixture, 'queue.db')
  const agentId = 'seat-continuity-fixture', project = 'product-fixture'
  const objective = 'Seat continuity fixture preserve objective'
  const nextAction = 'Inspect the same unfinished result'
  const decision = 'Seat continuity fixture: preserve durable work; source_ref=https://example.invalid/fixture-control#decision-1; source_sha256=' + 'a'.repeat(64)
  const isolatedEnv = { PATH: process.env.PATH ?? '', HOME: fixture, AGENT_MEMORY_DB_TYPE: 'sqlite', AGENT_MEMORY_DB_PATH: memoryDb }
  const node = execFileSync('which', ['node'], { encoding: 'utf8' }).trim()
  async function seed(seat: string, memoryProject: string, task: string) {
    const transport = new StdioClientTransport({ command: node, args: [entrypoint], env: { ...isolatedEnv, AGENT_MEMORY_AGENT_ID: seat, AGENT_MEMORY_PROJECT: memoryProject }, stderr: 'pipe' })
    const client = new Client({ name: 'seat-context-fixture-seeder', version: '1' })
    transport.stderr?.on('data', () => {})
    try {
      await client.connect(transport)
      for (const call of [
        { name: 'save_task_state', arguments: { task, status: 'in_progress', progress: 'seeded checkpoint', next_steps: nextAction, project: memoryProject } },
        { name: 'log_decision', arguments: { decision, project: memoryProject } },
      ]) {
        const result = await client.callTool(call)
        if (result.isError) throw new Error('MEMORY_FIXTURE_SEED_FAILED')
      }
    } finally { await client.close() }
  }
  let queue: Database | undefined
  try {
    const log = console.log
    try {
      console.log = (...args: unknown[]) => { process.stderr.write(args.map(String).join(' ') + '\n') }
      migrateSqlite(queueDbPath)
    } finally { console.log = log }
    queue = new Database(queueDbPath)
    queue.run(`INSERT INTO message_queue (agent_id,payload,status,claimed_by,claimed_at,claim_expires_at)
      VALUES (?,?,'in_progress','old-runtime','2026-09-13T00:00:00Z','2099-01-01T00:00:00Z')`, [agentId,
      JSON.stringify({ claim_token: 'fixture-fence-7', effects: [{ id: 'effect-done', status: 'completed' }, { id: 'effect-inflight', status: 'unknown' }] })])
    const snapshot = () => seatContextDigest(queue!.query('SELECT * FROM message_queue ORDER BY id').all())
    const queueBefore = snapshot()
    await seed(agentId, project, objective)
    await seed('other-seat', project, 'FOREIGN_AGENT_CONTEXT')
    await seed(agentId, 'other-project', 'FOREIGN_PROJECT_CONTEXT')
    const receipts = []
    let workDigest: string | undefined
    for (const [index, targetRuntime] of (['codex', 'claude', 'codex'] as const).entries()) {
      const cwd = join(fixture, `host-${index}`, `different-project-basename-${index}`)
      mkdirSync(cwd, { recursive: true })
      const runtimeInstanceId = `runtime-${index}`
      const result = await recoverSeatContext({
        agentId, project, runtimeInstanceId, targetRuntime, cwd,
        env: { ...isolatedEnv, CLAUDE_SESSION_ID: `session-${index}` },
        // Deliberately foreign global binding: helper must bind this exact seat.
        transport: { command: node, args: [entrypoint], env: { ...isolatedEnv, AGENT_MEMORY_AGENT_ID: 'arc', AGENT_MEMORY_PROJECT: 'foreign-global' } },
        consume: consumeContextViaStdin,
      })
      const serialized = JSON.stringify(result.context.context_data)
      if (!serialized.includes(objective) || !serialized.includes(nextAction) || !serialized.includes('fixture-control')
        || serialized.includes('FOREIGN_AGENT_CONTEXT') || serialized.includes('FOREIGN_PROJECT_CONTEXT')) throw new Error('MEMORY_FIXTURE_CONTINUITY_OR_ISOLATION_FAILED')
      if (workDigest && result.receipt.work_digest !== workDigest) throw new Error('MEMORY_FIXTURE_WORK_DIGEST_CHANGED')
      workDigest = result.receipt.work_digest
      if (!validateSeatContextReceipt(result.receipt, { agentId, project, runtimeInstanceId })
        || validateSeatContextReceipt(result.receipt, { agentId, project, runtimeInstanceId: `foreign-${index}` })) throw new Error('MEMORY_FIXTURE_RECEIPT_IDENTITY_FAILED')
      if (snapshot() !== queueBefore) throw new Error('MEMORY_FIXTURE_QUEUE_CHANGED')
      receipts.push(result.receipt)
    }
    let missingRejected = false
    try {
      await recoverSeatContext({ agentId: 'empty-seat', project, runtimeInstanceId: 'runtime-empty', targetRuntime: 'claude', cwd: fixture,
        env: isolatedEnv, transport: { command: node, args: [entrypoint], env: isolatedEnv },
        consume: async () => { throw new Error('EMPTY_SEAT_MUST_NOT_REACH_HOST') },
      })
    } catch (error) { missingRejected = (error as Error).message === 'MEMORY_CONTINUATION_INCOMPLETE' }
    if (!missingRejected) throw new Error('MEMORY_FIXTURE_EMPTY_SEAT_DID_NOT_FAIL_CLOSED')
    return {
      schema_version: 'seat-context-boundary-verification/v1', verdict: 'PASS',
      proof_scope: 'actual released Wasurezu MCP and SQLite plus local host-input subprocess; no LLM API or applied production claim',
      wasurezu: { root: release, source_head: sourceHead, entrypoint_sha256: entrypointSha },
      assertions: { provider_sequence: ['codex', 'claude', 'codex'], one_durable_store: true, new_workspaces_and_sessions: 3,
        objective_next_action_decision_preserved: true, work_digest_equal: true, decoys_excluded: true,
        ambient_foreign_binding_overridden: true, empty_seat_rejected_before_host_output: true,
        actual_host_input_subprocesses: 3, prior_runtime_receipt_rejected: true, queue_claim_effect_history_unchanged: snapshot() === queueBefore,
        provider_api_calls: 0, production_mutations: 0 },
      queue_before_digest: queueBefore, queue_after_digest: snapshot(), receipts,
    }
  } finally { queue?.close(); rmSync(fixture, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const index = process.argv.indexOf('--wasurezu-root')
  if (index < 0 || !process.argv[index + 1]) throw new Error('Required: --wasurezu-root <released checkout>; this verification cannot be skipped')
  console.log(JSON.stringify(await verifySeatContextContinuity(process.argv[index + 1]), null, 2))
}
