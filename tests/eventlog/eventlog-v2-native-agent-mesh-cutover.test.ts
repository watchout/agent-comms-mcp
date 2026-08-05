import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateV2NativeMeshDaemonFence } from '../../bin/aun/v2-worker-daemon'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  assertV1NativeMeshResidualUnchanged,
  dispatchV2NativeInternalHandoffs,
  ensureEventLogSchema,
  frozenEnabledSetSha256,
  readV1NativeMeshResidualSnapshot,
  routeV2NativeMessage,
  runtimeSnapshotSha256,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog'
import { deterministicV2NativeMeshRuntime } from '../../core/eventlog/runtimes'
import { runSeatWorkerOnce } from '../../core/eventlog/worker'
import { evaluateV2NativeMeshSupervisorFence } from '../../core/runtime-supervisor-adapter'
import { readV2NativeFrozenEnabledSet } from '../../core/runtime-inventory'

const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta'].map((agent, index) => ({
  agent_id: agent,
  profile_revision: '1',
  runtime_engine: 'deterministic-s0',
  runtime_instance_id: `runtime-${agent}`,
  runtime_checkout_root: `/fixture/${agent}`,
  runtime_checkout_sha: String(index + 4).repeat(40),
}))

function scope(): V2NativeMeshScopeV1 {
  return {
    schema_version: 'aun-v2-native-mesh-scope/v1',
    run_id: 's0-cutover-run',
    stage_id: 'S0_IMPLEMENTATION',
    repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: 'e325d1e6607360a67d337a9b2a77d5df8dd11477',
    database_identity: 'sqlite:isolated:s0-cutover',
    frozen_enabled_set: agents,
    frozen_enabled_set_sha256: frozenEnabledSetSha256(agents),
    runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    deadline_ms: Date.now() + 30_000,
  }
}

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'v2-native-cutover-'))
  db = new SqliteAdapter(join(dir, 'cutover.db'))
  await ensureEventLogSchema(db)
  await db.execute('CREATE TABLE message_queue (id INTEGER PRIMARY KEY)')
  await db.execute('CREATE TABLE agent_messages (id INTEGER PRIMARY KEY)')
  await db.execute('CREATE TABLE outbound_queue (id INTEGER PRIMARY KEY)')
  await db.execute(`CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY, profile_revision INTEGER, runtime_engine_preference TEXT,
    metadata TEXT, profile_enabled INTEGER, disabled_at TEXT, agent_type TEXT
  )`)
  await db.execute(`CREATE TABLE agent_runtime_instances (
    runtime_instance_id TEXT PRIMARY KEY, agent_id TEXT, runtime_engine TEXT,
    checkout_path TEXT, commit_sha TEXT, status TEXT, stopped_at TEXT,
    last_seen_at TEXT, started_at TEXT
  )`)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('V2-native S0 cutover and zero-effect fences', () => {
  test('native execution leaves V1 and provider surfaces at exact zero delta', async () => {
    const s = scope()
    const fence = {
      stage_id: 'S0_IMPLEMENTATION' as const,
      exact_implementation_head: s.exact_implementation_head,
      database_identity: s.database_identity,
      runtime_snapshot_sha256: s.runtime_snapshot_sha256,
    }
    const before = await readV1NativeMeshResidualSnapshot(db)
    await routeV2NativeMessage(db, s, fence, {
      route_id: 'alpha-beta', route_kind: 'direct', source_agent_id: 'alpha', recipient_agent_ids: ['beta'], content: 'request',
    })
    const runtime = deterministicV2NativeMeshRuntime(({ seatId }) => seatId === 'beta' ? 'reply' : null)
    await runSeatWorkerOnce(db, { seatId: 'beta', seatInstanceId: 'beta-1', runtime })
    const handoff = await dispatchV2NativeInternalHandoffs(db, s, fence, { dispatcherInstanceId: 'handoff-1' })
    await runSeatWorkerOnce(db, { seatId: 'alpha', seatInstanceId: 'alpha-1', runtime })
    const after = await readV1NativeMeshResidualSnapshot(db)
    assertV1NativeMeshResidualUnchanged(before, after)
    expect(handoff.providerInvocations).toBe(0)
    expect(handoff.externalSendAttempts).toBe(0)
    expect(handoff.V1Invocations).toBe(0)
    expect(Number((await db.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM event_log WHERE event_type IN ('reply.delivered','reply.provider_invocation_started')",
    ))?.n ?? 0)).toBe(0)
  })

  test('daemon and supervisor remain default-off/read-only and fail on drift', () => {
    expect(evaluateV2NativeMeshDaemonFence({})).toEqual({
      requested_mode: 'disabled',
      execute_allowed: false,
      activation_performed: false,
      provider_dispatch: 'disabled',
      V1_mode: 'observe_only_no_traversal',
      reason: 'default_off',
    })
    expect(evaluateV2NativeMeshDaemonFence({ AUN_V2_NATIVE_MESH_MODE: 'activate' }).reason)
      .toBe('S0_validation_only_live_activation_forbidden')

    const expected = agents.map(agent => ({
      agent_id: agent.agent_id,
      runtime_instance_id: agent.runtime_instance_id,
      runtime_checkout_root: agent.runtime_checkout_root,
      runtime_checkout_sha: agent.runtime_checkout_sha,
    }))
    const observed = expected.map(item => ({ ...item, ready: true }))
    expect(evaluateV2NativeMeshSupervisorFence(expected, observed)).toEqual({
      ok: true, mutation_performed: false, restart_performed: false, missing_or_drifted_agent_ids: [],
    })
    const drifted = observed.map(item => item.agent_id === 'beta' ? { ...item, runtime_checkout_sha: 'f'.repeat(40) } : item)
    expect(evaluateV2NativeMeshSupervisorFence(expected, drifted)).toEqual({
      ok: false, mutation_performed: false, restart_performed: false, missing_or_drifted_agent_ids: ['beta'],
    })
  })

  test('canonical selector freezes every enabled non-human agent with one exact ready runtime', async () => {
    const now = new Date().toISOString()
    const classificationEvidence = {
      profile_class_source_ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5186249673',
      profile_class_source_sha256: '82c3f997ecaed6a3e852a32118714169d078fcc24a2b05d8e4be725135524779',
      profile_class_plan_sha256: 'b'.repeat(64),
    }
    for (const [agentId, agentType, profileClass] of [
      ['alpha', 'bot', 'production'],
      ['beta', 'bot', 'production'],
      ['human-owner', 'human', 'production'],
      ['test-agent', 'bot', 'test'],
    ]) {
      await db.execute(
        `INSERT INTO agents VALUES ($1, 1, 'deterministic-s0', $2, 1, NULL, $3)`,
        [agentId, JSON.stringify({ profile_class: profileClass, ...classificationEvidence }), agentType],
      )
      await db.execute(
        `INSERT INTO agent_runtime_instances VALUES ($1, $2, 'deterministic-s0', $3, $4, 'ready', NULL, $5, $5)`,
        [`runtime-${agentId}`, agentId, `/fixture/${agentId}`, agentId === 'alpha' ? '4'.repeat(40) : '5'.repeat(40), now],
      )
    }
    expect(await readV2NativeFrozenEnabledSet(db, { nowMs: Date.now() })).toEqual(agents)

    await db.execute(
      `INSERT INTO agent_runtime_instances VALUES ('runtime-beta-duplicate', 'beta', 'deterministic-s0', '/fixture/beta', $1, 'ready', NULL, $2, $2)`,
      ['5'.repeat(40), now],
    )
    await expect(readV2NativeFrozenEnabledSet(db, { nowMs: Date.now() }))
      .rejects.toThrow('beta has 2 selected live runtimes')
  })

  test('provider or V1 escape literals fail before the first event', async () => {
    const s = scope()
    const fence = {
      stage_id: 'S0_IMPLEMENTATION' as const,
      exact_implementation_head: s.exact_implementation_head,
      database_identity: s.database_identity,
      runtime_snapshot_sha256: s.runtime_snapshot_sha256,
    }
    for (const escaped of [
      { ...s, provider_dispatch: 'enabled' },
      { ...s, V1_mode: 'fallback' },
    ]) {
      await expect(routeV2NativeMessage(db, escaped, fence, {
        route_id: 'forbidden', route_kind: 'direct', source_agent_id: 'alpha', recipient_agent_ids: ['beta'], content: 'x',
      })).rejects.toThrow()
    }
    expect(Number((await db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM event_log'))?.n ?? 0)).toBe(0)
  })
})
