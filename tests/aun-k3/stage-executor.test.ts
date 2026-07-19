import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { ensureEventLogSchema } from '../../core/eventlog/schema'
import { EventLog } from '../../core/eventlog/store'
import { deterministicV2NativeMeshRuntime } from '../../core/eventlog/runtimes'
import { dispatchV2NativeInternalHandoffs } from '../../core/eventlog/internal-handoff'
import { runV2NativeMeshTick } from '../../core/eventlog/worker'
import { activeTurnProjection } from '../../core/eventlog/views'
import {
  executeV2NativeStage,
  decodeV2NativeStageEvidence,
  preflightV2NativeStage,
  type V2NativeStageDatabaseReadbackV1,
  type V2NativeStageCrashBoundaryReceiptV1,
  type V2NativeStageOfflineReadbackV1,
  type V2NativeStagePreflightInputV1,
  type V2NativeStageSeatBindingV1,
} from '../../core/eventlog/v2-native-stage-executor'
import {
  canonicalV2NativeStageBindingSha256,
  stageMembershipSha256,
  type V2NativeActivationStageId,
  type V2NativeStageBaselinesV1,
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
const PATH_FIXTURE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'aun-actexec-paths-')))
const TRUE_EXE = realpathSync('/usr/bin/true')
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

afterAll(() => rmSync(PATH_FIXTURE_ROOT, { recursive: true, force: true }))

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
  return ['alpha', 'beta', 'gamma'].map(agentId => {
    const workspace = join(PATH_FIXTURE_ROOT, 'workspace', agentId)
    const checkout = join(PATH_FIXTURE_ROOT, 'checkout', agentId)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(checkout, { recursive: true })
    return {
    agent_id: agentId,
    enabled: true,
    active_function: 'implementation_executor',
    runtime_instance_id: `runtime-${agentId}`,
    workspace_realpath: realpathSync(workspace),
    checkout_root_realpath: realpathSync(checkout),
    checkout_sha: COMMIT,
    checkout_tree: TREE,
    engine: 'deterministic-fixture',
    status: 'running',
    last_seen_at: timestamp(-1_000),
    runtime_policy_sha256: SHA,
    runtime_build_sha256: SHA,
    config_sha256: SHA,
    }
  })
}

function membersFor(stage: V2NativeActivationStageId): string[] {
  return stage === 'S1_TWO_AGENT' ? ['alpha', 'beta'] : ['alpha', 'beta', 'gamma']
}

function priorFor(stage: V2NativeActivationStageId): V2NativeStageBindingV1['prior_gate_ref'] {
  if (stage === 'S1_TWO_AGENT') return 'K3_POST_MERGE_AND_INDEPENDENT_GATES'
  if (stage === 'S2_SELECTED_ENABLED') return 'S1_TERMINAL_PASS'
  return 'S2_TERMINAL_PASS'
}

function fixture(
  stage: V2NativeActivationStageId = 'S1_TWO_AGENT',
  runId: string = randomUUID(),
): {
  input: V2NativeStagePreflightInputV1
  binding: V2NativeStageBindingV1
} {
  const enabledRows = allRows()
  const members = membersFor(stage)
  const db = database()
  const binding: V2NativeStageBindingV1 = {
    schema_version: 'aun-v2-native-stage-binding/v1',
    run_id: runId,
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
      executable_realpath: TRUE_EXE,
      executable_sha256: SHA,
      checkout_sha: COMMIT,
      database_identity_sha256: db.identity_sha256,
    })),
    command_catalog: members.map(agentId => ({
      command_id: `seat:${agentId}`,
      exact_argv: [TRUE_EXE],
      cwd_realpath: enabledRows.find(row => row.agent_id === agentId)!.checkout_root_realpath,
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

function durableAuthority(source: { input: V2NativeStagePreflightInputV1 }) {
  return () => structuredClone(source.input)
}

function crashReceipt(
  source: ReturnType<typeof fixture>,
  boundary: V2NativeStageCrashBoundaryReceiptV1['boundary'],
): V2NativeStageCrashBoundaryReceiptV1 {
  const subject = source.binding.stage_members.agent_ids[0]
  const row = source.binding.frozen_enabled_snapshot.rows.find(candidate => candidate.agent_id === subject)!
  const common = {
    schema_version: 'aun-v2-native-crash-boundary-receipt/v1' as const,
    run_id: source.binding.run_id,
    stage_id: source.binding.stage_id as 'S2_SELECTED_ENABLED' | 'S3_ALL_ENABLED',
    subject_agent_id: subject,
    crashed_runtime_instance_id: row.runtime_instance_id,
    supervisor_evidence_ref: `fixture://supervisor/${boundary}`,
    occurred_at: timestamp(-100),
    rto_ms: 250,
    rpo_events: 0 as const,
    loss: 0 as const,
    duplicate_terminal: 0 as const,
    automatic_retry: 0 as const,
  }
  if (boundary === 'before_claim') return { ...common, boundary, eventual_claims: 1 }
  if (boundary === 'after_claim') return { ...common, boundary, claim_epoch_before: 1, claim_epoch_after: 2, stale_holder_terminal: 0 }
  if (boundary === 'after_completion_enqueue') {
    return { ...common, boundary, completion_cardinality: 1, enqueue_cardinality: 1, reply_delivery_cardinality: 1 }
  }
  return { ...common, boundary, delivery_unknown: 1, reconciliation_cas_winners: 1 }
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
  const activeTurns = (await activeTurnProjection(db))
    .filter(row => !['completed', 'blocked', 'dead_lettered'].includes(row.availability)).length
  const openDeliveries = Number((await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log q
      WHERE q.event_type = 'reply.enqueued'
        AND NOT EXISTS (
          SELECT 1 FROM event_log terminal
           WHERE terminal.reply_id = q.reply_id
             AND terminal.event_type IN ('reply.delivered', 'reply.handoff_accepted', 'reply.delivery_unknown')
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_log failed
           WHERE failed.reply_id = q.reply_id AND failed.event_type = 'reply.failed'
             AND (CAST(failed.payload AS TEXT) LIKE '%"permanent":true%' OR CAST(failed.payload AS TEXT) LIKE '%"kind":"permanent"%')
        )`,
  ))?.n ?? 0)
  return {
    database_identity_sha256: binding.database.identity_sha256,
    migration: binding.migration,
    baselines: {
      ...binding.pre_run_baselines,
      event_log_max_seq: Number(max?.n ?? 0),
      active_turn_count: activeTurns,
      open_delivery_count: openDeliveries,
    },
  }
}

async function eventCount(db: DbAdapter): Promise<number> {
  return Number((await db.queryOne<{ n: number | string }>('SELECT COUNT(*) AS n FROM event_log'))?.n ?? 0)
}

type ProtectedBoundaryDrift = {
  field: string
  stopReason: string
  projectionField?: 'active_turn_count' | 'open_delivery_count'
  apply?: (snapshot: V2NativeStageDatabaseReadbackV1) => void
  inject?: (
    db: DbAdapter,
    binding: V2NativeStageBindingV1,
    boundary: typeof PROTECTED_BOUNDARIES[number],
  ) => Promise<string>
}

const PROTECTED_BOUNDARY_DRIFTS: ProtectedBoundaryDrift[] = [
  {
    field: 'database_identity_sha256',
    stopReason: 'DATABASE_OR_MIGRATION_DRIFT',
    apply: snapshot => { snapshot.database_identity_sha256 = 'f'.repeat(64) },
  },
  {
    field: 'migration',
    stopReason: 'DATABASE_OR_MIGRATION_DRIFT',
    apply: snapshot => { snapshot.migration = { ...snapshot.migration, version: 'foreign-migration' } },
  },
  ...([
    'V1_message_queue_row_count',
    'V1_agent_messages_row_count',
    'V1_outbound_queue_row_count',
  ] as const).map(field => ({
    field,
    stopReason: 'V1_TRAVERSAL_DETECTED',
    apply: (snapshot: V2NativeStageDatabaseReadbackV1) => { snapshot.baselines[field] += 1 },
  })),
  ...([
    'provider_attempt_count',
    'provider_effect_count',
    'external_send_attempt_count',
  ] as const).map(field => ({
    field,
    stopReason: 'PROVIDER_OR_EXTERNAL_EFFECT_DETECTED',
    apply: (snapshot: V2NativeStageDatabaseReadbackV1) => { snapshot.baselines[field] += 1 },
  })),
]

const PROTECTED_BOUNDARIES = [
  { family: 'worker', name: 'seat:alpha:before_turn_claimed' },
  { family: 'internal_handoff', name: 'internal-handoff:after_injected_delivery_claimed_commit_point' },
] as const

type FixtureEventRow = {
  event_id: string
  event_type: string
  seat_id: string | null
  seat_instance_id: string | null
  conversation_id: string | null
  causation_id: string | null
  correlation_id: string | null
  turn_id: string | null
  reply_id: string | null
  claim_epoch: number | string | null
  payload: unknown
}

function eventPayload(row: FixtureEventRow): Record<string, unknown> {
  if (typeof row.payload === 'string') return JSON.parse(row.payload) as Record<string, unknown>
  return row.payload as Record<string, unknown>
}

async function fixtureReceived(db: DbAdapter, seat = 'alpha'): Promise<FixtureEventRow> {
  const row = await db.queryOne<FixtureEventRow>(
    `SELECT event_id, event_type, seat_id, seat_instance_id, conversation_id, causation_id,
            correlation_id, turn_id, reply_id, claim_epoch, payload
       FROM event_log WHERE event_type='message.received' AND seat_id=$1 ORDER BY seq LIMIT 1`,
    [seat],
  )
  if (!row) throw new Error(`fixture has no received event for ${seat}`)
  return row
}

async function fixtureDeliveryClaim(db: DbAdapter): Promise<FixtureEventRow> {
  const row = await db.queryOne<FixtureEventRow>(
    `SELECT event_id, event_type, seat_id, seat_instance_id, conversation_id, causation_id,
            correlation_id, turn_id, reply_id, claim_epoch, payload
       FROM event_log WHERE event_type='reply.delivery_claimed' ORDER BY seq DESC LIMIT 1`,
  )
  if (!row) throw new Error('fixture has no internal-handoff delivery claim')
  return row
}

async function insertFixtureEvent(
  db: DbAdapter,
  input: Omit<FixtureEventRow, 'payload'> & { payload: Record<string, unknown> },
): Promise<string> {
  await db.execute(
    `INSERT INTO event_log (
       event_id, event_type, occurred_at, seat_id, seat_instance_id, conversation_id,
       causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.event_id, input.event_type, timestamp(0), input.seat_id, input.seat_instance_id,
      input.conversation_id, input.causation_id, input.correlation_id, input.turn_id,
      input.reply_id, input.claim_epoch, JSON.stringify(input.payload),
    ],
  )
  return input.event_id
}

function stagePayload(binding: V2NativeStageBindingV1, extra: Record<string, unknown> = {}) {
  return { run_id: binding.run_id, stage_id: binding.stage_id, ...extra }
}

async function relatedEvent(
  db: DbAdapter,
  binding: V2NativeStageBindingV1,
  values: Partial<Omit<FixtureEventRow, 'payload'>> & { event_type: string; payload?: Record<string, unknown> },
): Promise<string> {
  const received = await fixtureReceived(db)
  const payload = eventPayload(received)
  return insertFixtureEvent(db, {
    event_id: values.event_id ?? `receipt:${randomUUID()}`,
    event_type: values.event_type,
    seat_id: values.seat_id === undefined ? received.seat_id : values.seat_id,
    seat_instance_id: values.seat_instance_id === undefined
      ? binding.frozen_enabled_snapshot.rows.find(row => row.agent_id === received.seat_id)?.runtime_instance_id ?? null
      : values.seat_instance_id,
    conversation_id: values.conversation_id === undefined ? received.conversation_id : values.conversation_id,
    causation_id: values.causation_id === undefined ? received.event_id : values.causation_id,
    correlation_id: values.correlation_id === undefined ? received.correlation_id : values.correlation_id,
    turn_id: values.turn_id === undefined ? received.turn_id : values.turn_id,
    reply_id: values.reply_id === undefined ? null : values.reply_id,
    claim_epoch: values.claim_epoch === undefined ? null : values.claim_epoch,
    payload: stagePayload(binding, { fixture_received_message_id: payload.message_id, ...(values.payload ?? {}) }),
  })
}

const PROVENANCE_PROJECTION_DRIFTS: ProtectedBoundaryDrift[] = [
  {
    field: 'unallowed_event_type_on_known_turn',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding, boundary) => relatedEvent(db, binding, {
      event_id: `receipt:${boundary.family}:unallowed_event_type_on_known_turn`,
      event_type: 'stage.unallowed_fixture',
    }),
  },
  {
    field: 'null_seat_owner_bypass',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding, boundary) => relatedEvent(db, binding, {
      event_id: `receipt:${boundary.family}:null_seat_owner_bypass`,
      event_type: 'reply.failed', seat_id: null, seat_instance_id: null,
      reply_id: `fixture-reply:${boundary.family}:null-seat`, claim_epoch: 0,
    }),
  },
  {
    field: 'internal_handoff_seat_bypass',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding, boundary) => relatedEvent(db, binding, {
      event_id: `receipt:${boundary.family}:internal_handoff_seat_bypass`,
      event_type: 'reply.failed', seat_id: 'v2-native-internal-handoff',
      seat_instance_id: `fixture-dispatcher:${boundary.family}:seat-bypass`,
      reply_id: `fixture-reply:${boundary.family}:seat-bypass`, claim_epoch: 0,
    }),
  },
  {
    field: 'wrong_route_ownership',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: async (db, binding, boundary) => {
      const received = await fixtureReceived(db)
      const payload = eventPayload(received)
      return insertFixtureEvent(db, {
        ...received,
        event_id: `receipt:${boundary.family}:wrong_route_ownership`,
        causation_id: received.causation_id,
        payload: { ...payload, run_id: binding.run_id, stage_id: binding.stage_id, route_id: `wrong-route:${boundary.family}` },
      })
    },
  },
  {
    field: 'wrong_reply_delivery_ownership',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding, boundary) => relatedEvent(db, binding, {
      event_id: `receipt:${boundary.family}:wrong_reply_delivery_ownership`,
      event_type: 'reply.failed', seat_id: 'v2-native-internal-handoff',
      seat_instance_id: `fixture-dispatcher:${boundary.family}:wrong-reply`,
      causation_id: `missing-enqueue:${boundary.family}`,
      reply_id: `fixture-reply:${boundary.family}:wrong-reply`, claim_epoch: 0,
    }),
  },
  {
    field: 'broken_causation_correlation',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding, boundary) => relatedEvent(db, binding, {
      event_id: `receipt:${boundary.family}:broken_causation_correlation`,
      event_type: 'turn.presented', causation_id: `missing-claim:${boundary.family}`,
      correlation_id: `wrong-correlation:${boundary.family}`, claim_epoch: 0,
    }),
  },
  {
    field: 'wrong_mutation_boundary',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: async (db, binding, boundary) => {
      const received = await fixtureReceived(db)
      const payload = eventPayload(received)
      const routeId = `fixture-route:${boundary.family}:wrong-mutation-boundary`
      const source = String(payload.source_agent_id)
      const recipient = String(payload.recipient_agent_id)
      const conversation = `mesh:${binding.run_id}:${routeId}`
      const correlation = `mesh-correlation:${binding.run_id}:${routeId}`
      return insertFixtureEvent(db, {
        event_id: `mesh-route-planned:${binding.run_id}:${routeId}`,
        event_type: 'message.route_planned',
        seat_id: source,
        seat_instance_id: null,
        conversation_id: conversation,
        causation_id: null,
        correlation_id: correlation,
        turn_id: null,
        reply_id: null,
        claim_epoch: null,
        payload: {
          schema_version: 'aun-v2-native-route-plan/v1', run_id: binding.run_id,
          scope_sha256: String(payload.scope_sha256), route_id: routeId, route_kind: 'direct',
          source_agent_id: source, conversation_id: conversation, correlation_id: correlation,
          content_sha256: SHA,
          children: [{ recipient_agent_id: recipient, message_id: `fixture-message:${routeId}`, delivery_id: `fixture-delivery:${routeId}` }],
          provider_dispatch: 'disabled', V1_mode: 'observe_only_no_traversal',
        },
      })
    },
  },
  {
    field: 'real_active_turn_projection_drift',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    projectionField: 'active_turn_count',
  },
  {
    field: 'real_open_delivery_projection_drift',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    projectionField: 'open_delivery_count',
  },
]

const RECEIPT_RUN_ID = '00000000-0000-4000-8000-000000000879'
const PROTECTED_COUNTER_FIELDS = [
  'V1_message_queue_row_count', 'V1_agent_messages_row_count', 'V1_outbound_queue_row_count',
  'provider_attempt_count', 'provider_effect_count', 'external_send_attempt_count',
] as const
const SNAPSHOT_FIELD_ORDER = [
  'database_identity_sha256', 'migration_identity_sha256', 'migration_version',
  'event_log_row_count', 'event_log_max_seq', 'active_turn_count', 'open_delivery_count',
  ...PROTECTED_COUNTER_FIELDS,
  'reply_delivery_claimed_count', 'reply_placement_count',
  'reply_handoff_accepted_count', 'later_reply_enqueued_count',
] as const

type ReceiptSnapshot = {
  database_identity_sha256: string
  migration_identity_sha256: string
  migration_version: string | null
  event_log_row_count: number
  event_log_max_seq: number
  active_turn_count: number
  open_delivery_count: number
  V1_message_queue_row_count: number
  V1_agent_messages_row_count: number
  V1_outbound_queue_row_count: number
  provider_attempt_count: number
  provider_effect_count: number
  external_send_attempt_count: number
  reply_delivery_claimed_count: number
  reply_placement_count: number
  reply_handoff_accepted_count: number
  later_reply_enqueued_count: number
}

type ReceiptIdentity = {
  receipt_id: string
  boundary_id: typeof PROTECTED_BOUNDARIES[number]['family']
  boundary_name: typeof PROTECTED_BOUNDARIES[number]['name']
  drift_id: string
  drift_class: 'protected' | 'provenance' | 'projection'
  injected_identity: {
    durable_source: 'database_readback' | 'event_log' | 'mutable_stage_projection'
    primary_identity: string
    event_id: string | null
    event_seq: number | null
    event_type: string | null
    changed_field: string
    injected_value: string | number | null
    injected_value_sha256: string
  }
  injected_identity_readback_equal: true
}

type NegativeBoundaryReceipt = {
  kind: 'negative'
  identity: ReceiptIdentity
  revalidation: {
    invocation_count: 1
    boundary_equal: true
    observed: true
    public_stop_reason: string
    internal_predicate_detail: string
  }
  terminal: {
    result: 'ROLLBACK_REQUEST'
    auto_advance: false
    rollback_evidence_preserved_after_close: true
    closeDatabase_callback_count: 1
    executor_owned_close: true
    manual_close_substituted_as_proof: false
  }
  snapshots_before_at_after: { before: ReceiptSnapshot; at: ReceiptSnapshot; after: ReceiptSnapshot }
  projection_predicate: null | {
    named_projection: 'active_turn_count' | 'open_delivery_count'
    accepted_event_log_max_seq: number
    current_event_log_max_seq: number
    newly_observed_interval_count: 0
    independently_derived_expected_delta: { active_turn_count: 0; open_delivery_count: 0 }
    observed_delta: { active_turn_count: number; open_delivery_count: number }
  }
  zero_subsequent_effects: {
    next_runtime_or_route_tick_count: 0
    next_effect_invocation_count: 0
    provider_V1_external_send_delta_after_rejection: 0
    placement_acceptance_later_enqueue_delta_after_rejection: 0
  }
}

type PositiveBoundaryReceipt = {
  kind: 'positive'
  identity: {
    receipt_id: string
    boundary_id: typeof PROTECTED_BOUNDARIES[number]['family']
    boundary_name: typeof PROTECTED_BOUNDARIES[number]['name']
  }
  ownership_tuple: {
    run_id: string
    route_id: string
    turn_id: string
    reply_id: string | null
    delivery_id: string
    causation_id: string
    mutation_boundary: string
  }
  snapshots_before_at_after: { before: ReceiptSnapshot; at: ReceiptSnapshot; after: ReceiptSnapshot }
  accepted_event_log_interval: { from_seq_exclusive: number; to_seq_inclusive: number; event_count: number }
  independently_derived_projection_delta: { active_turn_count: number; open_delivery_count: number }
  observed_projection_delta: { active_turn_count: number; open_delivery_count: number }
  accepted_snapshot_advancement: {
    before: { event_log_max_seq: number; active_turn_count: number; open_delivery_count: number }
    after: { event_log_max_seq: number; active_turn_count: number; open_delivery_count: number }
  }
  eventual_drain: { active_turn_count: 0; open_delivery_count: 0 }
  terminal: {
    result: 'MEASURED_PENDING_INDEPENDENT_GATES'
    auto_advance: false
    protected_counters_unchanged: true
    closeDatabase_callback_count: 1
  }
  zero_later_effect: {
    runtime_or_route_tick_count_after_close_snapshot: 0
    provider_V1_external_send_delta: 0
    placement_acceptance_later_enqueue_delta: 0
  }
}

type BoundaryReceipt = NegativeBoundaryReceipt | PositiveBoundaryReceipt
const boundaryReceiptIndex: BoundaryReceipt[] = []
const EXPECTED_RECEIPT_INDEX_SHA256 = '9f2a59ef95893da3e0f1cfeb954067205a6cef875237ddfdb9594b3dfd788b38'

async function receiptSnapshot(
  db: DbAdapter,
  binding: V2NativeStageBindingV1,
  mutate?: (snapshot: V2NativeStageDatabaseReadbackV1) => void,
): Promise<ReceiptSnapshot> {
  const readbackState = await receiptReadback(db, binding)
  mutate?.(readbackState)
  const current = readbackState.baselines
  const counts = await db.queryOne<{
    event_log_count: number | string
    delivery_claimed_count: number | string
    reply_placement_count: number | string
    handoff_accepted_count: number | string
    reply_enqueued_count: number | string
  }>(
    `SELECT
       COUNT(*) AS event_log_count,
       SUM(CASE WHEN event_type='reply.delivery_claimed' THEN 1 ELSE 0 END) AS delivery_claimed_count,
       SUM(CASE WHEN event_type='message.received' AND CAST(payload AS TEXT) LIKE '%"route_kind":"reply"%' THEN 1 ELSE 0 END) AS reply_placement_count,
       SUM(CASE WHEN event_type='reply.handoff_accepted' THEN 1 ELSE 0 END) AS handoff_accepted_count,
       SUM(CASE WHEN event_type='reply.enqueued' AND seq > COALESCE((
         SELECT MAX(claim.seq) FROM event_log claim WHERE claim.event_type='reply.delivery_claimed'
       ), 0) THEN 1 ELSE 0 END) AS reply_enqueued_count
     FROM event_log`,
  )
  return {
    database_identity_sha256: readbackState.database_identity_sha256,
    migration_identity_sha256: sha256Utf8(canonicalJson(readbackState.migration)),
    migration_version: readbackState.migration.version,
    event_log_row_count: Number(counts?.event_log_count ?? 0),
    event_log_max_seq: current.event_log_max_seq,
    active_turn_count: current.active_turn_count,
    open_delivery_count: current.open_delivery_count,
    V1_message_queue_row_count: current.V1_message_queue_row_count,
    V1_agent_messages_row_count: current.V1_agent_messages_row_count,
    V1_outbound_queue_row_count: current.V1_outbound_queue_row_count,
    provider_attempt_count: current.provider_attempt_count,
    provider_effect_count: current.provider_effect_count,
    external_send_attempt_count: current.external_send_attempt_count,
    reply_delivery_claimed_count: Number(counts?.delivery_claimed_count ?? 0),
    reply_placement_count: Number(counts?.reply_placement_count ?? 0),
    reply_handoff_accepted_count: Number(counts?.handoff_accepted_count ?? 0),
    later_reply_enqueued_count: Number(counts?.reply_enqueued_count ?? 0),
  }
}

async function receiptReadback(
  db: DbAdapter,
  binding: V2NativeStageBindingV1,
): Promise<V2NativeStageDatabaseReadbackV1> {
  const state = await readback(db, binding)
  const projectionDrifts = await db.query<{ projection_name: string; delta: number | string }>(
    'SELECT projection_name, delta FROM aun_stage_projection_drift_fixture ORDER BY projection_name',
  )
  for (const projection of projectionDrifts) {
    if (projection.projection_name === 'active_turn_count') {
      state.baselines.active_turn_count += Number(projection.delta)
    } else if (projection.projection_name === 'open_delivery_count') {
      state.baselines.open_delivery_count += Number(projection.delta)
    } else {
      throw new Error(`unknown fixture projection ${projection.projection_name}`)
    }
  }
  return state
}

function snapshotValues(snapshot: ReceiptSnapshot): Array<string | number | null> {
  return SNAPSHOT_FIELD_ORDER.map(field => snapshot[field])
}

function protectedDelta(left: ReceiptSnapshot, right: ReceiptSnapshot): number {
  return PROTECTED_COUNTER_FIELDS.reduce((sum, field) => sum + Math.abs(right[field] - left[field]), 0)
}

function protectedIncrease(left: ReceiptSnapshot, right: ReceiptSnapshot): number {
  return PROTECTED_COUNTER_FIELDS.reduce((sum, field) => sum + Math.max(0, right[field] - left[field]), 0)
}

function placementDelta(left: ReceiptSnapshot, right: ReceiptSnapshot): number {
  return Math.max(0, right.reply_placement_count - left.reply_placement_count) +
    Math.max(0, right.reply_handoff_accepted_count - left.reply_handoff_accepted_count) +
    Math.max(0, right.later_reply_enqueued_count - left.later_reply_enqueued_count)
}

function assertSnapshot(snapshot: ReceiptSnapshot): void {
  expect(Object.keys(snapshot)).toEqual(SNAPSHOT_FIELD_ORDER)
  expect(snapshot.database_identity_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(snapshot.migration_identity_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(snapshot.migration_version === null || typeof snapshot.migration_version === 'string').toBe(true)
  for (const field of SNAPSHOT_FIELD_ORDER.filter(field => ![
    'database_identity_sha256', 'migration_identity_sha256', 'migration_version',
  ].includes(field))) {
    expect(Number.isSafeInteger(snapshot[field] as number)).toBe(true)
    expect(snapshot[field] as number).toBeGreaterThanOrEqual(0)
  }
}

function assertAndAppendNegative(
  receipt: NegativeBoundaryReceipt,
  boundary: typeof PROTECTED_BOUNDARIES[number],
  drift: ProtectedBoundaryDrift,
): void {
  const { before, at, after } = receipt.snapshots_before_at_after
  expect(receipt.identity.receipt_id).toBe(`${boundary.family}:${drift.field}`)
  expect(receipt.identity).toMatchObject({
    boundary_id: boundary.family,
    boundary_name: boundary.name,
    drift_id: drift.field,
    injected_identity_readback_equal: true,
  })
  expect(receipt.identity.injected_identity.injected_value_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(receipt.revalidation).toMatchObject({
    invocation_count: 1, boundary_equal: true, observed: true, public_stop_reason: drift.stopReason,
  })
  expect(receipt.revalidation.internal_predicate_detail.length).toBeGreaterThan(0)
  expect(receipt.terminal).toEqual({
    result: 'ROLLBACK_REQUEST',
    auto_advance: false,
    rollback_evidence_preserved_after_close: true,
    closeDatabase_callback_count: 1,
    executor_owned_close: true,
    manual_close_substituted_as_proof: false,
  })
  assertSnapshot(before)
  assertSnapshot(at)
  assertSnapshot(after)
  if (boundary.family === 'worker') {
    expect(after).toEqual(before)
    expect(after.reply_delivery_claimed_count).toBe(0)
  } else {
    expect(after.reply_delivery_claimed_count).toBe(1)
    expect(after.reply_placement_count).toBe(0)
    expect(after.reply_handoff_accepted_count).toBe(0)
    expect(after.later_reply_enqueued_count).toBe(0)
  }
  expect(protectedDelta(before, after)).toBe(0)
  expect(receipt.zero_subsequent_effects).toEqual({
    next_runtime_or_route_tick_count: 0,
    next_effect_invocation_count: 0,
    provider_V1_external_send_delta_after_rejection: 0,
    placement_acceptance_later_enqueue_delta_after_rejection: 0,
  })
  if (drift.projectionField) {
    const expectedObserved = {
      active_turn_count: drift.projectionField === 'active_turn_count' ? 1 : 0,
      open_delivery_count: drift.projectionField === 'open_delivery_count' ? 1 : 0,
    }
    expect(receipt.projection_predicate).toEqual({
      named_projection: drift.projectionField,
      accepted_event_log_max_seq: before.event_log_max_seq,
      current_event_log_max_seq: at.event_log_max_seq,
      newly_observed_interval_count: 0,
      independently_derived_expected_delta: { active_turn_count: 0, open_delivery_count: 0 },
      observed_delta: expectedObserved,
    })
  } else {
    expect(receipt.projection_predicate).toBeNull()
  }
  const expectedPosition = boundaryReceiptIndex.length
  const expectedIds = PROTECTED_BOUNDARIES.flatMap(item => [
    ...[...PROTECTED_BOUNDARY_DRIFTS, ...PROVENANCE_PROJECTION_DRIFTS]
      .map(itemDrift => `${item.family}:${itemDrift.field}`),
    `${item.family}:positive_control`,
  ])
  expect(receipt.identity.receipt_id).toBe(expectedIds[expectedPosition])
  expect(boundaryReceiptIndex.some(existing => existing.identity.receipt_id === receipt.identity.receipt_id)).toBe(false)
  boundaryReceiptIndex.push(receipt)
}

function assertAndAppendPositive(
  receipt: PositiveBoundaryReceipt,
  boundary: typeof PROTECTED_BOUNDARIES[number],
): void {
  const { before, at, after } = receipt.snapshots_before_at_after
  expect(receipt.identity).toEqual({
    receipt_id: `${boundary.family}:positive_control`,
    boundary_id: boundary.family,
    boundary_name: boundary.name,
  })
  expect(receipt.ownership_tuple).toMatchObject({
    run_id: RECEIPT_RUN_ID,
    mutation_boundary: boundary.name,
  })
  for (const field of ['route_id', 'turn_id', 'delivery_id', 'causation_id'] as const) {
    expect(receipt.ownership_tuple[field].length).toBeGreaterThan(0)
  }
  assertSnapshot(before)
  assertSnapshot(at)
  assertSnapshot(after)
  expect(receipt.accepted_event_log_interval).toEqual({
    from_seq_exclusive: before.event_log_max_seq,
    to_seq_inclusive: at.event_log_max_seq,
    event_count: at.event_log_row_count - before.event_log_row_count,
  })
  expect(receipt.observed_projection_delta).toEqual(receipt.independently_derived_projection_delta)
  expect(receipt.accepted_snapshot_advancement).toEqual({
    before: {
      event_log_max_seq: before.event_log_max_seq,
      active_turn_count: before.active_turn_count,
      open_delivery_count: before.open_delivery_count,
    },
    after: {
      event_log_max_seq: at.event_log_max_seq,
      active_turn_count: at.active_turn_count,
      open_delivery_count: at.open_delivery_count,
    },
  })
  expect(receipt.eventual_drain).toEqual({ active_turn_count: 0, open_delivery_count: 0 })
  expect(receipt.terminal).toEqual({
    result: 'MEASURED_PENDING_INDEPENDENT_GATES',
    auto_advance: false,
    protected_counters_unchanged: true,
    closeDatabase_callback_count: 1,
  })
  expect(receipt.zero_later_effect).toEqual({
    runtime_or_route_tick_count_after_close_snapshot: 0,
    provider_V1_external_send_delta: 0,
    placement_acceptance_later_enqueue_delta: 0,
  })
  const expectedPosition = boundaryReceiptIndex.length
  const expectedIds = PROTECTED_BOUNDARIES.flatMap(item => [
    ...[...PROTECTED_BOUNDARY_DRIFTS, ...PROVENANCE_PROJECTION_DRIFTS]
      .map(itemDrift => `${item.family}:${itemDrift.field}`),
    `${item.family}:positive_control`,
  ])
  expect(receipt.identity.receipt_id).toBe(expectedIds[expectedPosition])
  expect(boundaryReceiptIndex.some(existing => existing.identity.receipt_id === receipt.identity.receipt_id)).toBe(false)
  boundaryReceiptIndex.push(receipt)
}

async function derivedProjectionDelta(
  db: DbAdapter,
  fromSeqExclusive: number,
  toSeqInclusive: number,
): Promise<{ active_turn_count: number; open_delivery_count: number }> {
  const rows = await db.query<{ event_type: string }>(
    'SELECT event_type FROM event_log WHERE seq>$1 AND seq<=$2 ORDER BY seq',
    [fromSeqExclusive, toSeqInclusive],
  )
  return rows.reduce((delta, row) => {
    if (row.event_type === 'message.received') delta.active_turn_count += 1
    if (['turn.completed', 'turn.blocked', 'turn.dead_lettered'].includes(row.event_type)) delta.active_turn_count -= 1
    if (row.event_type === 'reply.enqueued') delta.open_delivery_count += 1
    if (['reply.delivered', 'reply.handoff_accepted', 'reply.delivery_unknown'].includes(row.event_type)) {
      delta.open_delivery_count -= 1
    }
    return delta
  }, { active_turn_count: 0, open_delivery_count: 0 })
}

async function positiveOwnershipTuple(
  db: DbAdapter,
  binding: V2NativeStageBindingV1,
  boundary: typeof PROTECTED_BOUNDARIES[number],
): Promise<PositiveBoundaryReceipt['ownership_tuple']> {
  if (boundary.family === 'worker') {
    const received = await fixtureReceived(db)
    const payload = eventPayload(received)
    return {
      run_id: binding.run_id,
      route_id: String(payload.route_id),
      turn_id: String(received.turn_id),
      reply_id: null,
      delivery_id: String(payload.delivery_id),
      causation_id: String(received.causation_id),
      mutation_boundary: boundary.name,
    }
  }
  const claim = await fixtureDeliveryClaim(db)
  const received = await db.queryOne<FixtureEventRow>(
    `SELECT event_id, event_type, seat_id, seat_instance_id, conversation_id, causation_id,
            correlation_id, turn_id, reply_id, claim_epoch, payload
       FROM event_log WHERE event_type='message.received' AND turn_id=$1 ORDER BY seq LIMIT 1`,
    [claim.turn_id],
  )
  if (!received) throw new Error('fixture has no received ownership row for internal handoff')
  const payload = eventPayload(received)
  return {
    run_id: binding.run_id,
    route_id: String(payload.route_id),
    turn_id: String(claim.turn_id),
    reply_id: String(claim.reply_id),
    delivery_id: `mesh-internal:${claim.reply_id}`,
    causation_id: String(claim.causation_id),
    mutation_boundary: boundary.name,
  }
}

async function sqliteFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aun-actexec-'))
  const db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
  await db.execute(
    `CREATE TABLE aun_stage_projection_drift_fixture (
       projection_name TEXT PRIMARY KEY,
       delta INTEGER NOT NULL
     )`,
  )
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
      readDurableAuthority: durableAuthority(source),
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
        readDurableAuthority: durableAuthority(source),
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
        readDurableAuthority: durableAuthority(source),
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
      const arbitraryCrash = structuredClone(result.evidence) as unknown as Record<string, unknown>
      arbitraryCrash.crash_boundary_receipts = [{}]
      expect(() => decodeV2NativeStageEvidence(arbitraryCrash, result.plan)).toThrow(/EVIDENCE_INCOMPLETE_OR_STALE/)
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
        readDurableAuthority: durableAuthority(source),
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
    let opens = 0
    await expect(executeV2NativeStage(s2.input, {
      seats: seats(s2.binding),
      readDurableAuthority: durableAuthority(s2),
      readOfflineState: () => offlineReadback(s2.binding),
      openBoundDatabase: async () => { opens++; throw new Error('must not open') },
      readDatabaseState: readback,
    })).rejects.toThrow(/CRASH_RECOVERY_AMBIGUOUS/)
    const s1 = fixture('S1_TWO_AGENT')
    await expect(executeV2NativeStage(s1.input, {
      seats: seats(s1.binding),
      readDurableAuthority: durableAuthority(s1),
      readOfflineState: () => offlineReadback(s1.binding),
      openBoundDatabase: async () => { opens++; throw new Error('must not open') },
      readDatabaseState: readback,
      enableCrashHooks: true,
      runCrashScenario: async () => [],
    })).rejects.toThrow(/CRASH_RECOVERY_AMBIGUOUS/)
    expect(opens).toBe(0)
  })

  test('S2/S3 reject empty or partial crash receipts and S2 accepts only its exact planned boundary', async () => {
    const s2 = fixture('S2_SELECTED_ENABLED')
    for (const receipts of [[], [crashReceipt(s2, 'before_claim')]]) {
      const local = await sqliteFixture()
      try {
        const result = await executeV2NativeStage(s2.input, {
          seats: seats(s2.binding),
          readDurableAuthority: durableAuthority(s2),
          readOfflineState: () => offlineReadback(s2.binding),
          openBoundDatabase: async () => local.db,
          readDatabaseState: readback,
          enableCrashHooks: true,
          runCrashScenario: async () => receipts,
          closeDatabase: async () => {},
        })
        expect(result.ok).toBe(false)
        expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
        expect(result.evidence.terminal_result.stop_reason).toBe('CRASH_RECOVERY_AMBIGUOUS')
        await local.db.close()
      } finally {
        local.cleanup()
      }
    }

    const valid = await sqliteFixture()
    try {
      const result = await executeV2NativeStage(s2.input, {
        seats: seats(s2.binding),
        readDurableAuthority: durableAuthority(s2),
        readOfflineState: () => offlineReadback(s2.binding),
        openBoundDatabase: async () => valid.db,
        readDatabaseState: readback,
        enableCrashHooks: true,
        runCrashScenario: async () => [crashReceipt(s2, 'after_claim')],
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(true)
      expect(result.evidence.crash_boundary_receipts.map(receipt => receipt.boundary)).toEqual(['after_claim'])
      await valid.db.close()
    } finally {
      valid.cleanup()
    }

    const s3 = fixture('S3_ALL_ENABLED')
    const partialS3 = await sqliteFixture()
    try {
      const result = await executeV2NativeStage(s3.input, {
        seats: seats(s3.binding),
        readDurableAuthority: durableAuthority(s3),
        readOfflineState: () => offlineReadback(s3.binding),
        openBoundDatabase: async () => partialS3.db,
        readDatabaseState: readback,
        enableCrashHooks: true,
        runCrashScenario: async () => [
          crashReceipt(s3, 'before_claim'),
          crashReceipt(s3, 'after_claim'),
          crashReceipt(s3, 'after_completion_enqueue'),
        ],
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.stop_reason).toBe('CRASH_RECOVERY_AMBIGUOUS')
      await partialS3.db.close()
    } finally {
      partialS3.cleanup()
    }
  }, 20_000)

  test('wrong-queue and foreign-owner mutations are independently observed with the exact typed stop', async () => {
    const source = fixture('S2_SELECTED_ENABLED')
    for (const kind of ['wrong_queue', 'foreign_owner'] as const) {
      const local = await sqliteFixture()
      try {
        const result = await executeV2NativeStage(source.input, {
          seats: seats(source.binding),
          readDurableAuthority: durableAuthority(source),
          readOfflineState: () => offlineReadback(source.binding),
          openBoundDatabase: async () => local.db,
          readDatabaseState: readback,
          enableCrashHooks: true,
          runCrashScenario: async ({ db, plan }) => {
            if (kind === 'wrong_queue') {
              await new EventLog(db).append({
                eventId: `fixture-wrong-queue:${plan.binding.run_id}`,
                eventType: 'message.received',
                seatId: 'beta',
                conversationId: `mesh:${plan.binding.run_id}:wrong-queue`,
                correlationId: `mesh-correlation:${plan.binding.run_id}:wrong-queue`,
                turnId: `fixture-wrong-queue-turn:${plan.binding.run_id}`,
                payload: {
                  run_id: plan.binding.run_id,
                  stage_id: plan.binding.stage_id,
                  route_kind: 'direct',
                  source_agent_id: 'beta',
                  recipient_agent_id: 'alpha',
                  message_id: `fixture-wrong-queue-message:${plan.binding.run_id}`,
                },
              })
            } else {
              await new EventLog(db).append({
                eventId: `fixture-foreign-owner:${plan.binding.run_id}`,
                eventType: 'reply.handoff_accepted',
                seatId: 'foreign-agent',
                payload: { run_id: plan.binding.run_id, stage_id: plan.binding.stage_id },
              })
            }
            return [crashReceipt(source, 'after_claim')]
          },
          closeDatabase: async () => {},
        })
        expect(result.ok).toBe(false)
        expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
        expect(result.evidence.terminal_result.stop_reason).toBe('WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION')
        expect(result.evidence.direct_fanout_correlated_matrix_counts.wrong_queue_mutations).toBe(kind === 'wrong_queue' ? 1 : 0)
        expect(result.evidence.direct_fanout_correlated_matrix_counts.foreign_owner_mutations).toBe(kind === 'foreign_owner' ? 1 : 0)
        await local.db.close()
      } finally {
        local.cleanup()
      }
    }
  }, 20_000)

  test('correlated reply edges require the exact request-turn and enqueue causation chain', async () => {
    const source = fixture('S2_SELECTED_ENABLED')
    const local = await sqliteFixture()
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readDurableAuthority: durableAuthority(source),
        readOfflineState: () => offlineReadback(source.binding),
        openBoundDatabase: async () => local.db,
        readDatabaseState: readback,
        enableCrashHooks: true,
        runCrashScenario: async ({ db, plan }) => {
          await new EventLog(db).append({
            eventId: `fixture-uncorrelated-reply:${plan.binding.run_id}`,
            eventType: 'message.received',
            seatId: 'beta',
            conversationId: `mesh:${plan.binding.run_id}:uncorrelated`,
            correlationId: `mesh-correlation:${plan.binding.run_id}:uncorrelated`,
            causationId: 'fixture-nonexistent-enqueue',
            turnId: `fixture-uncorrelated-turn:${plan.binding.run_id}`,
            payload: {
              run_id: plan.binding.run_id,
              stage_id: plan.binding.stage_id,
              route_kind: 'reply',
              source_agent_id: 'alpha',
              recipient_agent_id: 'beta',
              message_id: `fixture-uncorrelated-message:${plan.binding.run_id}`,
            },
          })
          return [crashReceipt(source, 'after_claim')]
        },
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.stop_reason).toBe('WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION')
      expect(result.evidence.direct_fanout_correlated_matrix_counts.terminal_replies).toBe(7)
      expect(result.evidence.direct_fanout_correlated_matrix_counts.correlated_reply_edges).toBe(6)
      await local.db.close()
    } finally {
      local.cleanup()
    }
  }, 10_000)

  test('commit-point failure emits a typed rollback request with no auto-advance or implicit retry', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    let commitPoints = 0
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readDurableAuthority: durableAuthority(source),
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

  test('durable authority drift after an injected commit point stops before the next EventLog mutation', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    let current = structuredClone(source.input)
    let injected = 0
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readDurableAuthority: () => structuredClone(current),
        readOfflineState: () => offlineReadback(source.binding),
        openBoundDatabase: async () => local.db,
        readDatabaseState: readback,
        onCommitPoint: () => {
          injected++
          current = { ...current, owner_decision_body: `${current.owner_decision_body}\n` }
        },
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.stop_reason).toBe('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH')
      expect(injected).toBe(1)
      expect(await eventCount(local.db)).toBe(0)
      await local.db.close()
    } finally {
      local.cleanup()
    }
  })

  test('activation mesh tick rejects a missing complete mutation fence before EventLog mutation', async () => {
    const source = fixture()
    const plan = preflightV2NativeStage(source.input)
    const local = await sqliteFixture()
    try {
      await expect(runV2NativeMeshTick(local.db, {
        scope: plan.scope,
        fence: plan.fence,
        seats: seats(source.binding),
        instanceId: 'fixture-missing-mutation-fence',
      })).rejects.toThrow(/requires an asynchronous mutation revalidation callback/)
      await expect(dispatchV2NativeInternalHandoffs(local.db, plan.scope, plan.fence, {
        dispatcherInstanceId: 'fixture-missing-internal-handoff-fence',
      })).rejects.toThrow(/requires a mutation revalidation callback/)
      expect(await eventCount(local.db)).toBe(0)
      await local.db.close()
    } finally {
      local.cleanup()
    }
  })

  test('worker mutation boundary drift stops before the next EventLog effect', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    const current = offlineReadback(source.binding)
    let eventsAtDrift = -1
    let drifted = false
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readDurableAuthority: durableAuthority(source),
        readOfflineState: () => structuredClone(current),
        openBoundDatabase: async () => local.db,
        readDatabaseState: readback,
        onMeshMutationBoundary: async boundary => {
          if (!drifted && boundary === 'seat:alpha:before_turn_claimed') {
            eventsAtDrift = await eventCount(local.db)
            current.stage_member_rows[0].runtime_policy_sha256 = 'f'.repeat(64)
            drifted = true
          }
        },
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.stop_reason).toBe('ENABLED_SNAPSHOT_DRIFT')
      expect(drifted).toBe(true)
      expect(await eventCount(local.db)).toBe(eventsAtDrift)
      await local.db.close()
    } finally {
      local.cleanup()
    }
  })

  test('internal handoff commit-boundary drift preserves the claim and blocks placement', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    const current = offlineReadback(source.binding)
    let eventsAtDrift = -1
    let drifted = false
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: seats(source.binding),
        readDurableAuthority: durableAuthority(source),
        readOfflineState: () => structuredClone(current),
        openBoundDatabase: async () => local.db,
        readDatabaseState: readback,
        onMeshMutationBoundary: async boundary => {
          if (!drifted && boundary === 'internal-handoff:after_injected_delivery_claimed_commit_point') {
            eventsAtDrift = await eventCount(local.db)
            current.stage_member_rows[0].runtime_build_sha256 = 'f'.repeat(64)
            drifted = true
          }
        },
        closeDatabase: async () => {},
      })
      expect(result.ok).toBe(false)
      expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
      expect(result.evidence.terminal_result.stop_reason).toBe('ENABLED_SNAPSHOT_DRIFT')
      expect(drifted).toBe(true)
      expect(await eventCount(local.db)).toBe(eventsAtDrift)
      expect(Number((await local.db.queryOne<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.delivery_claimed'",
      ))?.n ?? 0)).toBe(1)
      expect(Number((await local.db.queryOne<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.handoff_accepted'",
      ))?.n ?? 0)).toBe(0)
      await local.db.close()
    } finally {
      local.cleanup()
    }
  }, 10_000)

  for (const boundary of PROTECTED_BOUNDARIES) {
    for (const drift of [...PROTECTED_BOUNDARY_DRIFTS, ...PROVENANCE_PROJECTION_DRIFTS]) {
      test(`protected boundary receipt ${boundary.family}:${drift.field} stops with ${drift.stopReason}`, async () => {
        const source = fixture('S1_TWO_AGENT', RECEIPT_RUN_ID)
        const local = await sqliteFixture()
        let injected = false
        let pendingInjectedRevalidation = false
        let injectedRevalidationCount = 0
        let injectedEvent: { event_id: string; event_type: string; seq: number } | null = null
        let before: ReceiptSnapshot | null = null
        let at: ReceiptSnapshot | null = null
        let after: ReceiptSnapshot | null = null
        let closeCount = 0
        let postInjectionBoundaryCount = 0
        try {
          const result = await executeV2NativeStage(source.input, {
            seats: seats(source.binding),
            readDurableAuthority: durableAuthority(source),
            readOfflineState: () => offlineReadback(source.binding),
            openBoundDatabase: async () => local.db,
            readDatabaseState: async (db, binding) => {
              const snapshot = await receiptReadback(db, binding)
              if (injected) drift.apply?.(snapshot)
              if (pendingInjectedRevalidation) {
                injectedRevalidationCount += 1
                pendingInjectedRevalidation = false
              }
              return snapshot
            },
            onMeshMutationBoundary: async currentBoundary => {
              if (!injected && currentBoundary === boundary.name) {
                before = await receiptSnapshot(local.db, source.binding)
                if (drift.inject) {
                  const eventId = await drift.inject(local.db, source.binding, boundary)
                  const row = await local.db.queryOne<{ event_id: string; event_type: string; seq: number | string }>(
                    'SELECT event_id, event_type, seq FROM event_log WHERE event_id=$1',
                    [eventId],
                  )
                  if (!row) throw new Error(`injected event ${eventId} is not durably readable`)
                  injectedEvent = { event_id: row.event_id, event_type: row.event_type, seq: Number(row.seq) }
                } else if (drift.projectionField) {
                  await local.db.execute(
                    'INSERT INTO aun_stage_projection_drift_fixture (projection_name, delta) VALUES ($1, $2)',
                    [drift.projectionField, 1],
                  )
                  const projection = await local.db.queryOne<{ delta: number | string }>(
                    'SELECT delta FROM aun_stage_projection_drift_fixture WHERE projection_name=$1',
                    [drift.projectionField],
                  )
                  expect(Number(projection?.delta ?? 0)).toBe(1)
                }
                injected = true
                at = await receiptSnapshot(local.db, source.binding, drift.apply)
                pendingInjectedRevalidation = true
              } else if (injected) {
                postInjectionBoundaryCount += 1
              }
            },
            closeDatabase: async db => {
              closeCount += 1
              after = await receiptSnapshot(db, source.binding)
              await db.close()
            },
          })
          expect(injected).toBe(true)
          expect(before).not.toBeNull()
          expect(at).not.toBeNull()
          expect(after).not.toBeNull()
          expect(closeCount).toBe(1)
          expect(postInjectionBoundaryCount).toBe(0)
          expect(injectedRevalidationCount).toBe(1)
          expect(result.ok).toBe(false)
          expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
          expect(result.evidence.terminal_result.auto_advance).toBe(false)
          expect(result.evidence.terminal_result.stop_reason).toBe(drift.stopReason)
          const terminalError = result.evidence.terminal_result.error
          let internalPredicateDetail: string
          if (drift.projectionField) {
            const baseDetail = 'mutable stage projection delta is not owned by the exact accepted lifecycle interval'
            expect(terminalError).toContain(baseDetail)
            internalPredicateDetail = `${baseDetail}:${drift.projectionField}`
            expect(at!.event_log_max_seq).toBe(before!.event_log_max_seq)
            expect(at!.event_log_row_count).toBe(before!.event_log_row_count)
            expect(at!.active_turn_count - before!.active_turn_count).toBe(
              drift.projectionField === 'active_turn_count' ? 1 : 0,
            )
            expect(at!.open_delivery_count - before!.open_delivery_count).toBe(
              drift.projectionField === 'open_delivery_count' ? 1 : 0,
            )
            expect(injectedEvent).toBeNull()
          } else if (injectedEvent) {
            internalPredicateDetail =
              `unbound ${injectedEvent.event_type} event ${injectedEvent.event_id} appeared at ${boundary.name}`
            expect(terminalError).toContain(internalPredicateDetail)
            expect(at!.event_log_max_seq).toBe(injectedEvent.seq)
            expect(at!.event_log_row_count).toBe(before!.event_log_row_count + 1)
          } else {
            internalPredicateDetail = drift.field === 'database_identity_sha256' || drift.field === 'migration'
              ? 'database identity or migration readback differs'
              : drift.field.startsWith('V1_')
                ? 'current V1 row counts differ from the frozen pre-run baseline'
                : 'current provider or external counters differ from the frozen pre-run baseline'
            expect(terminalError).toContain(internalPredicateDetail)
          }

          const driftClass: ReceiptIdentity['drift_class'] = drift.projectionField
            ? 'projection'
            : PROTECTED_BOUNDARY_DRIFTS.includes(drift)
              ? 'protected'
              : 'provenance'
          const injectedValue = injectedEvent
            ? injectedEvent.event_id
            : drift.field === 'migration'
              ? at!.migration_identity_sha256
              : at![drift.projectionField ?? drift.field as keyof ReceiptSnapshot] as string | number | null
          const injectedIdentity: ReceiptIdentity['injected_identity'] = {
            durable_source: injectedEvent
              ? 'event_log'
              : drift.projectionField
                ? 'mutable_stage_projection'
                : 'database_readback',
            primary_identity: injectedEvent?.event_id ??
              (drift.projectionField
                ? `aun_stage_projection_drift_fixture:${drift.projectionField}`
                : drift.field),
            event_id: injectedEvent?.event_id ?? null,
            event_seq: injectedEvent?.seq ?? null,
            event_type: injectedEvent?.event_type ?? null,
            changed_field: drift.projectionField ?? drift.field,
            injected_value: injectedValue,
            injected_value_sha256: sha256Utf8(canonicalJson(injectedValue)),
          }
          const projectionPredicate = drift.projectionField
            ? {
                named_projection: drift.projectionField,
                accepted_event_log_max_seq: before!.event_log_max_seq,
                current_event_log_max_seq: at!.event_log_max_seq,
                newly_observed_interval_count: 0 as const,
                independently_derived_expected_delta: {
                  active_turn_count: 0 as const,
                  open_delivery_count: 0 as const,
                },
                observed_delta: {
                  active_turn_count: at!.active_turn_count - before!.active_turn_count,
                  open_delivery_count: at!.open_delivery_count - before!.open_delivery_count,
                },
              }
            : null
          const receipt: NegativeBoundaryReceipt = {
            kind: 'negative',
            identity: {
              receipt_id: `${boundary.family}:${drift.field}`,
              boundary_id: boundary.family,
              boundary_name: boundary.name,
              drift_id: drift.field,
              drift_class: driftClass,
              injected_identity: injectedIdentity,
              injected_identity_readback_equal: true,
            },
            revalidation: {
              invocation_count: 1,
              boundary_equal: true,
              observed: true,
              public_stop_reason: drift.stopReason,
              internal_predicate_detail: internalPredicateDetail,
            },
            terminal: {
              result: 'ROLLBACK_REQUEST',
              auto_advance: false,
              rollback_evidence_preserved_after_close: true,
              closeDatabase_callback_count: 1,
              executor_owned_close: true,
              manual_close_substituted_as_proof: false,
            },
            snapshots_before_at_after: { before: before!, at: at!, after: after! },
            projection_predicate: projectionPredicate,
            zero_subsequent_effects: {
              next_runtime_or_route_tick_count: 0,
              next_effect_invocation_count: 0,
              provider_V1_external_send_delta_after_rejection: protectedIncrease(at!, after!),
              placement_acceptance_later_enqueue_delta_after_rejection: placementDelta(at!, after!),
            },
          }
          assertAndAppendNegative(receipt, boundary, drift)
        } finally {
          local.cleanup()
        }
      }, 10_000)
    }

    test(`positive protected boundary receipt ${boundary.family} accepts exact stage-owned progress`, async () => {
      const source = fixture('S1_TWO_AGENT', RECEIPT_RUN_ID)
      const local = await sqliteFixture()
      let observed = false
      let closeCount = 0
      let before: ReceiptSnapshot | null = null
      let at: ReceiptSnapshot | null = null
      let after: ReceiptSnapshot | null = null
      let afterReadback: ReceiptSnapshot | null = null
      let ownership: PositiveBoundaryReceipt['ownership_tuple'] | null = null
      let expectedDelta: PositiveBoundaryReceipt['independently_derived_projection_delta'] | null = null
      try {
        const result = await executeV2NativeStage(source.input, {
          seats: seats(source.binding),
          readDurableAuthority: durableAuthority(source),
          readOfflineState: () => offlineReadback(source.binding),
          openBoundDatabase: async () => {
            before = await receiptSnapshot(local.db, source.binding)
            return local.db
          },
          readDatabaseState: readback,
          onMeshMutationBoundary: async currentBoundary => {
            if (!observed && currentBoundary === boundary.name) {
              observed = true
              at = await receiptSnapshot(local.db, source.binding)
              ownership = await positiveOwnershipTuple(local.db, source.binding, boundary)
              expectedDelta = await derivedProjectionDelta(
                local.db,
                before!.event_log_max_seq,
                at.event_log_max_seq,
              )
            }
          },
          closeDatabase: async db => {
            closeCount += 1
            after = await receiptSnapshot(db, source.binding)
            afterReadback = await receiptSnapshot(db, source.binding)
            await db.close()
          },
        })
        expect(observed).toBe(true)
        expect(result.ok).toBe(true)
        expect(result.result).toBe('MEASURED_PENDING_INDEPENDENT_GATES')
        expect(before).not.toBeNull()
        expect(at).not.toBeNull()
        expect(after).not.toBeNull()
        expect(afterReadback).toEqual(after)
        expect(ownership).not.toBeNull()
        expect(expectedDelta).not.toBeNull()
        expect(closeCount).toBe(1)
        expect(after!.active_turn_count).toBe(0)
        expect(after!.open_delivery_count).toBe(0)
        expect(result.evidence.terminal_result.auto_advance).toBe(false)
        const receipt: PositiveBoundaryReceipt = {
          kind: 'positive',
          identity: {
            receipt_id: `${boundary.family}:positive_control`,
            boundary_id: boundary.family,
            boundary_name: boundary.name,
          },
          ownership_tuple: ownership!,
          snapshots_before_at_after: { before: before!, at: at!, after: after! },
          accepted_event_log_interval: {
            from_seq_exclusive: before!.event_log_max_seq,
            to_seq_inclusive: at!.event_log_max_seq,
            event_count: at!.event_log_row_count - before!.event_log_row_count,
          },
          independently_derived_projection_delta: expectedDelta!,
          observed_projection_delta: {
            active_turn_count: at!.active_turn_count - before!.active_turn_count,
            open_delivery_count: at!.open_delivery_count - before!.open_delivery_count,
          },
          accepted_snapshot_advancement: {
            before: {
              event_log_max_seq: before!.event_log_max_seq,
              active_turn_count: before!.active_turn_count,
              open_delivery_count: before!.open_delivery_count,
            },
            after: {
              event_log_max_seq: at!.event_log_max_seq,
              active_turn_count: at!.active_turn_count,
              open_delivery_count: at!.open_delivery_count,
            },
          },
          eventual_drain: { active_turn_count: 0, open_delivery_count: 0 },
          terminal: {
            result: 'MEASURED_PENDING_INDEPENDENT_GATES',
            auto_advance: false,
            protected_counters_unchanged: protectedDelta(before!, after!) === 0,
            closeDatabase_callback_count: closeCount,
          },
          zero_later_effect: {
            runtime_or_route_tick_count_after_close_snapshot: 0,
            provider_V1_external_send_delta: protectedDelta(after!, afterReadback!),
            placement_acceptance_later_enqueue_delta: placementDelta(after!, afterReadback!),
          },
        }
        assertAndAppendPositive(receipt, boundary)
      } finally {
        local.cleanup()
      }
    }, 15_000)
  }

  test('publishes the complete deterministic 34 negative plus 2 positive receipt index', () => {
    const expectedIds = PROTECTED_BOUNDARIES.flatMap(boundary => [
      ...[...PROTECTED_BOUNDARY_DRIFTS, ...PROVENANCE_PROJECTION_DRIFTS]
        .map(drift => `${boundary.family}:${drift.field}`),
      `${boundary.family}:positive_control`,
    ])
    const ids = boundaryReceiptIndex.map(receipt => receipt.identity.receipt_id)
    expect(boundaryReceiptIndex).toHaveLength(36)
    expect(boundaryReceiptIndex.filter(receipt => receipt.kind === 'negative')).toHaveLength(34)
    expect(boundaryReceiptIndex.filter(receipt => receipt.kind === 'positive')).toHaveLength(2)
    expect(new Set(ids).size).toBe(36)
    expect(ids).toEqual(expectedIds)

    const negativeFieldOrder = [
      'kind',
      'identity.receipt_id', 'identity.boundary_id', 'identity.boundary_name',
      'identity.drift_id', 'identity.drift_class',
      'identity.injected_identity.durable_source', 'identity.injected_identity.primary_identity',
      'identity.injected_identity.event_id', 'identity.injected_identity.event_seq',
      'identity.injected_identity.event_type', 'identity.injected_identity.changed_field',
      'identity.injected_identity.injected_value', 'identity.injected_identity.injected_value_sha256',
      'identity.injected_identity_readback_equal',
      'revalidation.invocation_count', 'revalidation.boundary_equal', 'revalidation.observed',
      'revalidation.public_stop_reason', 'revalidation.internal_predicate_detail',
      'terminal.result', 'terminal.auto_advance', 'terminal.rollback_evidence_preserved_after_close',
      'terminal.closeDatabase_callback_count', 'terminal.executor_owned_close',
      'terminal.manual_close_substituted_as_proof',
      'snapshots_before_at_after.before', 'snapshots_before_at_after.at', 'snapshots_before_at_after.after',
      'projection_predicate.named_projection', 'projection_predicate.accepted_event_log_max_seq',
      'projection_predicate.current_event_log_max_seq', 'projection_predicate.newly_observed_interval_count',
      'projection_predicate.independently_derived_expected_delta.active_turn_count',
      'projection_predicate.independently_derived_expected_delta.open_delivery_count',
      'projection_predicate.observed_delta.active_turn_count',
      'projection_predicate.observed_delta.open_delivery_count',
      'zero_subsequent_effects.next_runtime_or_route_tick_count',
      'zero_subsequent_effects.next_effect_invocation_count',
      'zero_subsequent_effects.provider_V1_external_send_delta_after_rejection',
      'zero_subsequent_effects.placement_acceptance_later_enqueue_delta_after_rejection',
    ] as const
    const positiveFieldOrder = [
      'kind', 'identity.receipt_id', 'identity.boundary_id', 'identity.boundary_name',
      'ownership_tuple.run_id', 'ownership_tuple.route_id', 'ownership_tuple.turn_id',
      'ownership_tuple.reply_id', 'ownership_tuple.delivery_id', 'ownership_tuple.causation_id',
      'ownership_tuple.mutation_boundary',
      'snapshots_before_at_after.before', 'snapshots_before_at_after.at', 'snapshots_before_at_after.after',
      'accepted_event_log_interval.from_seq_exclusive', 'accepted_event_log_interval.to_seq_inclusive',
      'accepted_event_log_interval.event_count',
      'independently_derived_projection_delta.active_turn_count',
      'independently_derived_projection_delta.open_delivery_count',
      'observed_projection_delta.active_turn_count', 'observed_projection_delta.open_delivery_count',
      'accepted_snapshot_advancement.before.event_log_max_seq',
      'accepted_snapshot_advancement.before.active_turn_count',
      'accepted_snapshot_advancement.before.open_delivery_count',
      'accepted_snapshot_advancement.after.event_log_max_seq',
      'accepted_snapshot_advancement.after.active_turn_count',
      'accepted_snapshot_advancement.after.open_delivery_count',
      'eventual_drain.active_turn_count', 'eventual_drain.open_delivery_count',
      'terminal.result', 'terminal.auto_advance', 'terminal.protected_counters_unchanged',
      'terminal.closeDatabase_callback_count',
      'zero_later_effect.runtime_or_route_tick_count_after_close_snapshot',
      'zero_later_effect.provider_V1_external_send_delta',
      'zero_later_effect.placement_acceptance_later_enqueue_delta',
    ] as const
    const receipts = boundaryReceiptIndex.map(receipt => {
      const snapshots = receipt.snapshots_before_at_after
      if (receipt.kind === 'negative') {
        const injected = receipt.identity.injected_identity
        const projection = receipt.projection_predicate
        return [
          receipt.kind,
          receipt.identity.receipt_id, receipt.identity.boundary_id, receipt.identity.boundary_name,
          receipt.identity.drift_id, receipt.identity.drift_class,
          injected.durable_source, injected.primary_identity, injected.event_id, injected.event_seq,
          injected.event_type, injected.changed_field, injected.injected_value, injected.injected_value_sha256,
          receipt.identity.injected_identity_readback_equal,
          receipt.revalidation.invocation_count, receipt.revalidation.boundary_equal, receipt.revalidation.observed,
          receipt.revalidation.public_stop_reason, receipt.revalidation.internal_predicate_detail,
          receipt.terminal.result, receipt.terminal.auto_advance,
          receipt.terminal.rollback_evidence_preserved_after_close,
          receipt.terminal.closeDatabase_callback_count, receipt.terminal.executor_owned_close,
          receipt.terminal.manual_close_substituted_as_proof,
          snapshotValues(snapshots.before), snapshotValues(snapshots.at), snapshotValues(snapshots.after),
          projection?.named_projection ?? null,
          projection?.accepted_event_log_max_seq ?? null,
          projection?.current_event_log_max_seq ?? null,
          projection?.newly_observed_interval_count ?? null,
          projection?.independently_derived_expected_delta.active_turn_count ?? null,
          projection?.independently_derived_expected_delta.open_delivery_count ?? null,
          projection?.observed_delta.active_turn_count ?? null,
          projection?.observed_delta.open_delivery_count ?? null,
          receipt.zero_subsequent_effects.next_runtime_or_route_tick_count,
          receipt.zero_subsequent_effects.next_effect_invocation_count,
          receipt.zero_subsequent_effects.provider_V1_external_send_delta_after_rejection,
          receipt.zero_subsequent_effects.placement_acceptance_later_enqueue_delta_after_rejection,
        ]
      }
      return [
        receipt.kind,
        receipt.identity.receipt_id, receipt.identity.boundary_id, receipt.identity.boundary_name,
        receipt.ownership_tuple.run_id, receipt.ownership_tuple.route_id, receipt.ownership_tuple.turn_id,
        receipt.ownership_tuple.reply_id, receipt.ownership_tuple.delivery_id, receipt.ownership_tuple.causation_id,
        receipt.ownership_tuple.mutation_boundary,
        snapshotValues(snapshots.before), snapshotValues(snapshots.at), snapshotValues(snapshots.after),
        receipt.accepted_event_log_interval.from_seq_exclusive,
        receipt.accepted_event_log_interval.to_seq_inclusive,
        receipt.accepted_event_log_interval.event_count,
        receipt.independently_derived_projection_delta.active_turn_count,
        receipt.independently_derived_projection_delta.open_delivery_count,
        receipt.observed_projection_delta.active_turn_count,
        receipt.observed_projection_delta.open_delivery_count,
        receipt.accepted_snapshot_advancement.before.event_log_max_seq,
        receipt.accepted_snapshot_advancement.before.active_turn_count,
        receipt.accepted_snapshot_advancement.before.open_delivery_count,
        receipt.accepted_snapshot_advancement.after.event_log_max_seq,
        receipt.accepted_snapshot_advancement.after.active_turn_count,
        receipt.accepted_snapshot_advancement.after.open_delivery_count,
        receipt.eventual_drain.active_turn_count, receipt.eventual_drain.open_delivery_count,
        receipt.terminal.result, receipt.terminal.auto_advance,
        receipt.terminal.protected_counters_unchanged, receipt.terminal.closeDatabase_callback_count,
        receipt.zero_later_effect.runtime_or_route_tick_count_after_close_snapshot,
        receipt.zero_later_effect.provider_V1_external_send_delta,
        receipt.zero_later_effect.placement_acceptance_later_enqueue_delta,
      ]
    })
    const receiptIndex = {
      schema_version: 'aun-v2-native-stage-boundary-receipt-index/v1',
      snapshot_field_order: SNAPSHOT_FIELD_ORDER,
      negative_receipt_field_order: negativeFieldOrder,
      positive_receipt_field_order: positiveFieldOrder,
      receipt_order: ids,
      receipts,
    }
    const body = canonicalJson(receiptIndex)
    const bodySha256 = sha256Utf8(body)
    expect(canonicalJson(JSON.parse(body))).toBe(body)
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(48_000)
    expect(bodySha256).toBe(EXPECTED_RECEIPT_INDEX_SHA256)
    console.log(`AUN_ACTEXEC_RECEIPT_INDEX_UTF8_BYTES=${Buffer.byteLength(body, 'utf8')}`)
    console.log(`AUN_ACTEXEC_RECEIPT_INDEX_SHA256=${bodySha256}`)
    console.log(`AUN_ACTEXEC_RECEIPT_INDEX_JSON=${body}`)
  })

  test('silent runtime output preserves partial evidence and becomes a matrix rollback, never PASS', async () => {
    const source = fixture()
    const local = await sqliteFixture()
    const silentRuntime = deterministicV2NativeMeshRuntime(() => null)
    const silentSeats = seats(source.binding).map(seat => ({ ...seat, runtime: silentRuntime }))
    try {
      const result = await executeV2NativeStage(source.input, {
        seats: silentSeats,
        readDurableAuthority: durableAuthority(source),
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
      readDurableAuthority: durableAuthority(source),
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
