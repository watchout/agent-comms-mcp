import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { ensureEventLogSchema } from '../../core/eventlog/schema'
import { deterministicV2NativeMeshRuntime } from '../../core/eventlog/runtimes'
import { runV2NativeMeshTick } from '../../core/eventlog/worker'
import {
  executeV2NativeStage,
  decodeV2NativeStageEvidence,
  preflightV2NativeStage,
  type V2NativeStageDatabaseReadbackV1,
  type V2NativeStageOfflineReadbackV1,
  type V2NativeStagePreflightInputV1,
  type V2NativeStageSeatBindingV1,
} from '../../core/eventlog/v2-native-stage-executor'
import {
  canonicalV2NativeStageBindingSha256,
  stageMembershipSha256,
  type V2NativeActivationStageId,
  type V2NativeStageBindingV1,
  type V2NativeStageEnabledRowV1,
  type V2NativeStageOwnerDecisionV1,
} from '../../core/eventlog/v2-native-stage-binding'
import { canonicalJson, sha256Utf8 } from '../../core/eventlog/transport-contract'

const COMMIT = 'a'.repeat(40)
const TREE = 'b'.repeat(40)
const SHA = 'c'.repeat(64)
const DECISION_URL = 'https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-1234567891'
const BINDING_URL = 'https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-1234567893'
const ROOT = resolve(import.meta.dir, '../..')
const K1_UP = readFileSync(resolve(ROOT, 'db/migrations/2026-07-16-aun-k1-event-projection-claim.up.sql'), 'utf8')
const K2_UP = readFileSync(resolve(ROOT, 'db/migrations/2026-07-16-aun-k2-runtime-supervision.up.sql'), 'utf8')
const EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), seat_id TEXT, seat_instance_id TEXT,
    conversation_id TEXT, causation_id TEXT, correlation_id TEXT, turn_id TEXT, reply_id TEXT,
    claim_epoch INTEGER, payload JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX uq_el_turn_claim ON event_log(turn_id, claim_epoch) WHERE event_type='turn.claimed';
  CREATE UNIQUE INDEX uq_el_turn_completed ON event_log(turn_id) WHERE event_type='turn.completed';
  CREATE UNIQUE INDEX uq_el_delivery_claim ON event_log(reply_id, claim_epoch) WHERE event_type='reply.delivery_claimed';
  CREATE UNIQUE INDEX uq_el_reply_delivered ON event_log(reply_id) WHERE event_type='reply.delivered';
  CREATE INDEX idx_el_type_reply ON event_log(event_type, reply_id);
`

function timestamp(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString()
}

function database() {
  const identity = {
    engine: 'PostgreSQL' as const,
    server_version: '17.5',
    cluster_fingerprint_sha256: 'd'.repeat(64),
    database_name: 'aun_actexec_fixture_executor',
    database_oid: 16385,
    schema_name: 'public',
  }
  return { ...identity, identity_sha256: sha256Utf8(canonicalJson(identity)) }
}

function allRows(): V2NativeStageEnabledRowV1[] {
  return ['alpha', 'beta', 'gamma'].map(agentId => ({
    agent_id: agentId,
    enabled: true,
    active_function: 'implementation_executor',
    runtime_instance_id: `runtime-${agentId}`,
    workspace_realpath: `/fixture/workspace/${agentId}`,
    checkout_root_realpath: `/fixture/checkout/${agentId}`,
    checkout_sha: COMMIT,
    checkout_tree: TREE,
    engine: 'deterministic-fixture',
    status: 'running',
    last_seen_at: timestamp(-1_000),
    runtime_policy_sha256: SHA,
    runtime_build_sha256: SHA,
    config_sha256: SHA,
  }))
}

function membersFor(stage: V2NativeActivationStageId): string[] {
  return stage === 'S1_TWO_AGENT' ? ['alpha', 'beta'] : ['alpha', 'beta', 'gamma']
}

function priorFor(stage: V2NativeActivationStageId): V2NativeStageBindingV1['prior_gate_ref'] {
  if (stage === 'S1_TWO_AGENT') return 'K3_POST_MERGE_AND_INDEPENDENT_GATES'
  if (stage === 'S2_SELECTED_ENABLED') return 'S1_TERMINAL_PASS'
  return 'S2_TERMINAL_PASS'
}

function fixture(stage: V2NativeActivationStageId = 'S1_TWO_AGENT'): {
  input: V2NativeStagePreflightInputV1
  binding: V2NativeStageBindingV1
} {
  const enabledRows = allRows()
  const members = membersFor(stage)
  const db = database()
  const binding: V2NativeStageBindingV1 = {
    schema_version: 'aun-v2-native-stage-binding/v1',
    run_id: randomUUID(),
    stage_id: stage,
    exact_implementation_main_sha: COMMIT,
    exact_implementation_main_tree: TREE,
    database: db,
    migration: { required: false, version: null, up_blob_sha256: null, down_blob_sha256: null, applied_at: null, decision_ref: null, receipt_ref: null },
    frozen_enabled_snapshot: {
      artifact_url: DECISION_URL,
      canonical_json_sha256: sha256Utf8(canonicalJson(enabledRows)),
      cardinality: enabledRows.length,
      generated_at: timestamp(-2_000),
      query_digest: 'e'.repeat(64),
      rows: enabledRows,
    },
    stage_members: { agent_ids: members, cardinality: members.length, membership_sha256: stageMembershipSha256(members) },
    started_at: timestamp(-5_000),
    deadline: timestamp(180_000),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    pre_run_baselines: {
      event_log_max_seq: 0,
      active_turn_count: 0,
      open_delivery_count: 0,
      V1_message_queue_row_count: 0,
      V1_agent_messages_row_count: 0,
      V1_outbound_queue_row_count: 0,
      provider_attempt_count: 0,
      provider_effect_count: 0,
      external_send_attempt_count: 0,
    },
    supervisor_processes: members.map((agentId, index) => ({
      unit_kind: 'seat',
      agent_id_or_dispatcher_id: agentId,
      runtime_instance_id: `runtime-${agentId}`,
      pid: 2000 + index,
      process_start_time: timestamp(-10_000),
      executable_realpath: '/usr/bin/true',
      executable_sha256: SHA,
      checkout_sha: COMMIT,
      database_identity_sha256: db.identity_sha256,
    })),
    command_catalog: members.map(agentId => ({
      command_id: `seat:${agentId}`,
      exact_argv: ['/usr/bin/true'],
      cwd_realpath: `/fixture/checkout/${agentId}`,
      allowed_env_keys: [],
      env_value_hashes: {},
      timeout_seconds: 120,
      executable_sha256: SHA,
    })),
    approval_ref: {
      owner: 'owner-human', durable_url: DECISION_URL, body_sha256: '0'.repeat(64),
      exact_stage_id: stage, exact_binding_sha256: '0'.repeat(64),
    },
    prior_gate_ref: priorFor(stage),
  }
  const bindingSha = canonicalV2NativeStageBindingSha256(binding)
  const decision: V2NativeStageOwnerDecisionV1 = {
    schema_version: 'shirube-v3/v2-native-stage-owner-decision/v1',
    decision_id: randomUUID(),
    owner: 'owner-human',
    decision: 'APPROVE_STAGE_ACTIVATION',
    status: 'active',
    exact_stage_id: stage,
    exact_binding_sha256: bindingSha,
    issued_at: timestamp(-4_000),
    expires_at: timestamp(170_000),
    superseded_by: null,
    crash_hooks: stage === 'S1_TWO_AGENT' ? 'disabled' : 'planned_stage_bound',
  }
  const body = JSON.stringify(decision)
  const bodySha = sha256Utf8(body)
  binding.approval_ref.exact_binding_sha256 = bindingSha
  binding.approval_ref.body_sha256 = bodySha
  return {
    binding,
    input: {
      binding,
      binding_url: BINDING_URL,
      binding_sha256: bindingSha,
      owner_decision_body: body,
      owner_decision_url: DECISION_URL,
      owner_decision_body_sha256: bodySha,
      exact_implementation_main_sha: COMMIT,
      exact_implementation_main_tree: TREE,
    },
  }
}

function runtime() {
  return deterministicV2NativeMeshRuntime(({ content, seatId, sourceAgentId }) =>
    content.startsWith('stage-direct-request:') ? `correlated-reply:${seatId}:${sourceAgentId}` : null,
  )
}

function seats(binding: V2NativeStageBindingV1): V2NativeStageSeatBindingV1[] {
  const seatRuntime = runtime()
  return binding.stage_members.agent_ids.map(agentId => {
    const row = binding.frozen_enabled_snapshot.rows.find(candidate => candidate.agent_id === agentId)!
    return {
      seatId: agentId,
      runtime: seatRuntime,
      runtimeInstanceId: row.runtime_instance_id,
      runtimeCheckoutRoot: row.checkout_root_realpath,
      runtimeCheckoutSha: row.checkout_sha,
      commandId: `seat:${agentId}`,
    }
  })
}

function offlineReadback(binding: V2NativeStageBindingV1): V2NativeStageOfflineReadbackV1 {
  return {
    exact_implementation_main_sha: binding.exact_implementation_main_sha,
    exact_implementation_main_tree: binding.exact_implementation_main_tree,
    stage_member_rows: binding.frozen_enabled_snapshot.rows.filter(row => binding.stage_members.agent_ids.includes(row.agent_id)),
    command_catalog: binding.command_catalog,
  }
}

async function readback(db: DbAdapter, binding: V2NativeStageBindingV1): Promise<V2NativeStageDatabaseReadbackV1> {
  const max = await db.queryOne<{ n: number | string | null }>('SELECT MAX(seq) AS n FROM event_log')
  return {
    database_identity_sha256: binding.database.identity_sha256,
    migration: binding.migration,
    baselines: {
      ...binding.pre_run_baselines,
      event_log_max_seq: Number(max?.n ?? 0),
    },
  }
}

async function eventCount(db: DbAdapter): Promise<number> {
  return Number((await db.queryOne<{ n: number | string }>('SELECT COUNT(*) AS n FROM event_log'))?.n ?? 0)
}

async function sqliteFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aun-actexec-'))
  const db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
  return { db, cleanup() { rmSync(dir, { recursive: true, force: true }) } }
}

describe('AUN V2 native stage executor', () => {
  test('preflight and runtime drift fail before DB construction or model/EventLog effects', async () => {
    const source = fixture()
    let opens = 0
    const badHead = { ...source.input, exact_implementation_main_sha: 'f'.repeat(40) }
    expect(() => preflightV2NativeStage(badHead)).toThrow(/BASE_OR_TREE_DRIFT/)

    const badSeats = seats(source.binding)
    badSeats[0].runtimeInstanceId = 'drifted-runtime'
    await expect(executeV2NativeStage(source.input, {
      seats: badSeats,
      readOfflineState: () => offlineReadback(source.binding),
      openBoundDatabase: async () => { opens++; throw new Error('must not open') },
      readDatabaseState: readback,
    })).rejects.toThrow(/RUNTIME_BINDING_DRIFT/)
    expect(opens).toBe(0)

    const offlineDrifts: Array<(readback: V2NativeStageOfflineReadbackV1) => void> = [
      readback => { readback.exact_implementation_main_sha = 'f'.repeat(40) },
      readback => { readback.exact_implementation_main_tree = 'f'.repeat(40) },
      readback => { readback.stage_member_rows[0].checkout_sha = 'f'.repeat(40) },
      readback => { readback.stage_member_rows[0].runtime_policy_sha256 = 'f'.repeat(64) },
      readback => { readback.stage_member_rows[0].runtime_build_sha256 = 'f'.repeat(64) },
      readback => { readback.stage_member_rows[0].config_sha256 = 'f'.repeat(64) },
      readback => { readback.command_catalog[0].executable_sha256 = 'f'.repeat(64) },
    ]
    for (const drift of offlineDrifts) {
      const current = structuredClone(offlineReadback(source.binding))
      drift(current)
      await expect(executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readOfflineState: () => current,
        openBoundDatabase: async () => { opens++; throw new Error('must not open') },
        readDatabaseState: readback,
      })).rejects.toThrow(/(?:BASE_OR_TREE|RUNTIME_BINDING|COMMAND_CATALOG)_DRIFT/)
    }
    expect(opens).toBe(0)
  })

  test('runs the isolated S1 2-agent direct/fanout/correlated matrix with zero residual or forbidden effects', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    let opens = 0
    let ticks = 0
    let offlineChecks = 0
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readOfflineState: () => { offlineChecks++; return offlineReadback(source.binding) },
        openBoundDatabase: async () => { opens++; return local.db },
        readDatabaseState: readback,
        runMeshTick: async (...args) => { ticks++; return runV2NativeMeshTick(...args) },
        closeDatabase: async () => { await local.db.close() },
      })
      const counts = result.evidence.direct_fanout_correlated_matrix_counts
      expect(result.ok, JSON.stringify({ terminal: result.evidence.terminal_result, counts })).toBe(true)
      expect(result.result).toBe('MEASURED_PENDING_INDEPENDENT_GATES')
      expect(counts).toMatchObject({
        member_count: 2,
        directed_requests: 2,
        terminal_replies: 2,
        fanout_parents: 2,
        fanout_children: 2,
        correlated_reply_edges: 2,
        missing: 0,
        duplicates: 0,
        unexpected_recipients: 0,
        wrong_queue_mutations: 0,
        foreign_owner_mutations: 0,
        open_turns_after_drain: 0,
        pending_internal_deliveries_after_drain: 0,
        V1_invocations: 0,
        provider_attempts: 0,
        provider_effects: 0,
        external_send_attempts: 0,
      })
      expect(opens).toBe(1)
      expect(ticks).toBeGreaterThan(0)
      expect(offlineChecks).toBeGreaterThan(6)
      expect(result.evidence.implementation_audit_ref).toBeNull()
      expect(result.evidence.scenario_verification_ref).toBeNull()
      expect(result.evidence.terminal_result).toEqual({
        kind: 'MEASURED_PENDING_INDEPENDENT_GATES',
        stop_reason: 'EVIDENCE_INCOMPLETE_OR_STALE',
        auto_advance: false,
      })
      expect(result.plan.crash_hooks_enabled).toBe(false)
      expect(result.plan.activation_performed).toBe(false)
      expect(() => decodeV2NativeStageEvidence(result.evidence, result.plan)).not.toThrow()
      const extra = { ...result.evidence, unexpected: true }
      expect(() => decodeV2NativeStageEvidence(extra, result.plan)).toThrow(/EVIDENCE_INCOMPLETE_OR_STALE/)
      const falseAccept = structuredClone(result.evidence)
      falseAccept.terminal_result = { kind: 'ACCEPT_STAGE', stop_reason: null, auto_advance: false }
      expect(() => decodeV2NativeStageEvidence(falseAccept, result.plan)).toThrow(/ACCEPT_STAGE is missing/)
    } finally {
      local.cleanup()
    }
  })

  test('DB drift blocks before the first EventLog mutation and model invocation', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    let closed = false
    let eventsAtClose = -1
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readOfflineState: () => offlineReadback(source.binding),
        openBoundDatabase: async () => local.db,
        readDatabaseState: async (db, binding) => ({
          ...(await readback(db, binding)),
          database_identity_sha256: 'f'.repeat(64),
        }),
        closeDatabase: async () => { eventsAtClose = await eventCount(local.db); closed = true; await local.db.close() },
      })
      expect(result.ok).toBe(false)
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.stop_reason).toBe('DATABASE_OR_MIGRATION_DRIFT')
      expect(eventsAtClose).toBe(0)
      expect(closed).toBe(true)
    } finally {
      local.cleanup()
    }
  })

  test('S2/S3 crash hooks are default-off and require exact explicit stage authority', async () => {
    const s2 = fixture('S2_SELECTED_ENABLED')
    expect(preflightV2NativeStage(s2.input).crash_hooks_enabled).toBe(false)
    const s1 = fixture('S1_TWO_AGENT')
    let opens = 0
    await expect(executeV2NativeStage(s1.input, {
      seats: seats(s1.binding),
      readOfflineState: () => offlineReadback(s1.binding),
      openBoundDatabase: async () => { opens++; throw new Error('must not open') },
      readDatabaseState: readback,
      enableCrashHooks: true,
      runCrashScenario: async () => [],
    })).rejects.toThrow(/CRASH_RECOVERY_AMBIGUOUS/)
    expect(opens).toBe(0)
  })

  test('commit-point failure emits a typed rollback request with no auto-advance or implicit retry', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    let commitPoints = 0
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readOfflineState: () => offlineReadback(source.binding),
        openBoundDatabase: async () => local.db,
        readDatabaseState: readback,
        onCommitPoint: () => {
          commitPoints++
          throw new Error('injected commit-point failure')
        },
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.result).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.auto_advance).toBe(false)
      expect(commitPoints).toBe(1)
      expect(await eventCount(local.db)).toBe(0)
      await local.db.close()
    } finally {
      local.cleanup()
    }
  })

  test('silent runtime output preserves partial evidence and becomes a matrix rollback, never PASS', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    const silentRuntime = deterministicV2NativeMeshRuntime(() => null)
    const silentSeats = seats(source.binding).map(seat => ({ ...seat, runtime: silentRuntime }))
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: silentSeats,
        readOfflineState: () => offlineReadback(source.binding),
        openBoundDatabase: async () => local.db,
        readDatabaseState: readback,
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.stop_reason).toBe('MATRIX_COUNT_MISMATCH')
      expect(result.evidence.direct_fanout_correlated_matrix_counts).toMatchObject({
        directed_requests: 2,
        terminal_replies: 0,
        fanout_parents: 2,
        fanout_children: 2,
      })
      expect(result.evidence.event_identities.length).toBeGreaterThan(0)
      expect(result.evidence.terminal_result.auto_advance).toBe(false)
      await local.db.close()
    } finally {
      local.cleanup()
    }
  })
})

const pgFixtureEnabled = process.env.AUN_ACTEXEC_DB_SCOPE === 'isolated_disposable_fixture'
;(pgFixtureEnabled ? test : test.skip)('guarded disposable PostgreSQL fixture runs the same exact S1 matrix', async () => {
  const databaseUrl = process.env.AUN_ACTEXEC_TEST_DATABASE_URL
  if (!databaseUrl) throw new Error('AUN_ACTEXEC_TEST_DATABASE_URL is required')
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''))
  if (!databaseName.startsWith('aun_actexec_fixture_')) throw new Error(`unsafe fixture database ${databaseName}`)
  if (process.env.DATABASE_URL !== databaseUrl) throw new Error('DATABASE_URL must equal AUN_ACTEXEC_TEST_DATABASE_URL')
  const { PgAdapter } = await import('../../core/db/pg-adapter')
  const db = new PgAdapter(databaseUrl)
  const schema = `actexec_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  try {
    await db.execute(`CREATE SCHEMA "${schema}"`)
    await db.execute(`SET search_path TO "${schema}", public`)
    await db.execute(EVENT_LOG_DDL)
    await db.execute(K1_UP)
    await db.execute(K2_UP)
    const source = fixture()
    const result = await executeV2NativeStage(source.input, {
      seats: seats(source.binding),
      readOfflineState: () => offlineReadback(source.binding),
      openBoundDatabase: async () => db,
      readDatabaseState: readback,
      closeDatabase: async () => {},
    })
    expect(result.ok).toBe(true)
    expect(result.evidence.direct_fanout_correlated_matrix_counts).toMatchObject({
      directed_requests: 2, terminal_replies: 2, fanout_parents: 2, fanout_children: 2,
      correlated_reply_edges: 2, missing: 0, duplicates: 0,
    })
  } finally {
    await db.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await db.close()
  }
})
