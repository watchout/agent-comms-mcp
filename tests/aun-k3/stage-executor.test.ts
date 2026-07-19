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
    inject: (db, binding) => relatedEvent(db, binding, { event_type: 'stage.unallowed_fixture' }),
  },
  {
    field: 'null_seat_owner_bypass',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding) => relatedEvent(db, binding, {
      event_type: 'reply.failed', seat_id: null, seat_instance_id: null,
      reply_id: `fixture-reply:${randomUUID()}`, claim_epoch: 0,
    }),
  },
  {
    field: 'internal_handoff_seat_bypass',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding) => relatedEvent(db, binding, {
      event_type: 'reply.failed', seat_id: 'v2-native-internal-handoff',
      seat_instance_id: `fixture-dispatcher:${randomUUID()}`,
      reply_id: `fixture-reply:${randomUUID()}`, claim_epoch: 0,
    }),
  },
  {
    field: 'wrong_route_ownership',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: async (db, binding) => {
      const received = await fixtureReceived(db)
      const payload = eventPayload(received)
      return insertFixtureEvent(db, {
        ...received,
        event_id: `receipt:${randomUUID()}`,
        causation_id: received.causation_id,
        payload: { ...payload, run_id: binding.run_id, stage_id: binding.stage_id, route_id: `wrong-route:${randomUUID()}` },
      })
    },
  },
  {
    field: 'wrong_reply_delivery_ownership',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding) => relatedEvent(db, binding, {
      event_type: 'reply.failed', seat_id: 'v2-native-internal-handoff',
      seat_instance_id: `fixture-dispatcher:${randomUUID()}`,
      causation_id: `missing-enqueue:${randomUUID()}`,
      reply_id: `fixture-reply:${randomUUID()}`, claim_epoch: 0,
    }),
  },
  {
    field: 'broken_causation_correlation',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: (db, binding) => relatedEvent(db, binding, {
      event_type: 'turn.presented', causation_id: `missing-claim:${randomUUID()}`,
      correlation_id: `wrong-correlation:${randomUUID()}`, claim_epoch: 0,
    }),
  },
  {
    field: 'wrong_mutation_boundary',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: async (db, binding) => {
      const received = await fixtureReceived(db)
      const payload = eventPayload(received)
      const routeId = `fixture-route:${randomUUID()}`
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
    inject: async (db, binding) => {
      const received = await fixtureReceived(db)
      const identity = await relatedEvent(db, binding, { event_type: 'stage.projection_marker' })
      await db.execute(
        `UPDATE event_log_turn_projection SET availability='completed', updated_seq=updated_seq+1 WHERE turn_id=$1`,
        [received.turn_id],
      )
      return identity
    },
  },
  {
    field: 'real_open_delivery_projection_drift',
    stopReason: 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION',
    inject: async (db, binding, boundary) => {
      if (boundary.family === 'worker') {
        return relatedEvent(db, binding, {
          event_type: 'reply.enqueued', reply_id: `fixture-reply:${randomUUID()}`,
          payload: { content: 'fixture-open-delivery', channel_external_id: null },
        })
      }
      const claim = await fixtureDeliveryClaim(db)
      return insertFixtureEvent(db, {
        event_id: `receipt:${randomUUID()}`,
        event_type: 'reply.handoff_accepted',
        seat_id: 'v2-native-internal-handoff',
        seat_instance_id: claim.seat_instance_id,
        conversation_id: claim.conversation_id,
        causation_id: claim.event_id,
        correlation_id: claim.correlation_id,
        turn_id: claim.turn_id,
        reply_id: claim.reply_id,
        claim_epoch: claim.claim_epoch,
        payload: {
          reply_id: claim.reply_id, delivery_id: `mesh-internal:${claim.reply_id}`,
          recipient_seat_id: 'alpha', receipt_digest: SHA, fanout_child_provenance_digest: null,
        },
      })
    },
  },
]

type ReceiptSnapshot = V2NativeStageBaselinesV1 & {
  event_log_count: number
  delivery_claimed_count: number
  reply_placement_count: number
  handoff_accepted_count: number
  reply_enqueued_count: number
}

async function receiptSnapshot(db: DbAdapter, binding: V2NativeStageBindingV1): Promise<ReceiptSnapshot> {
  const current = (await readback(db, binding)).baselines
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
       SUM(CASE WHEN event_type='reply.enqueued' THEN 1 ELSE 0 END) AS reply_enqueued_count
     FROM event_log`,
  )
  return {
    ...current,
    event_log_count: Number(counts?.event_log_count ?? 0),
    delivery_claimed_count: Number(counts?.delivery_claimed_count ?? 0),
    reply_placement_count: Number(counts?.reply_placement_count ?? 0),
    handoff_accepted_count: Number(counts?.handoff_accepted_count ?? 0),
    reply_enqueued_count: Number(counts?.reply_enqueued_count ?? 0),
  }
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
        const source = fixture()
        const local = await sqliteFixture()
        let injected = false
        let injectedIdentity: string | null = null
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
              const snapshot = await readback(db, binding)
              if (injected) drift.apply?.(snapshot)
              return snapshot
            },
            onMeshMutationBoundary: async currentBoundary => {
              if (!injected && currentBoundary === boundary.name) {
                before = await receiptSnapshot(local.db, source.binding)
                injectedIdentity = drift.inject
                  ? await drift.inject(local.db, source.binding, boundary)
                  : `readback:${drift.field}`
                injected = true
                at = await receiptSnapshot(local.db, source.binding)
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
          expect(injectedIdentity).not.toBeNull()
          expect(before).not.toBeNull()
          expect(at).not.toBeNull()
          if (boundary.family === 'worker') {
            // The worker seam runs inside the claim transaction. The durable
            // invalid row/projection is visible at injection and is then
            // rolled back with that transaction; no later executor effect is
            // allowed to replace it.
            expect(after).toEqual(before)
            if (drift.inject) expect(at!.event_log_count).toBe(before!.event_log_count + 1)
          } else {
            // The internal-handoff seam is after the delivery-claim commit;
            // the injected durable identity remains the terminal snapshot.
            expect(after).toEqual(at)
          }
          expect(closeCount).toBe(1)
          expect(postInjectionBoundaryCount).toBe(0)
          expect(result.ok).toBe(false)
          expect(result.evidence.terminal_result.kind).toBe('ROLLBACK_REQUEST')
          expect(result.evidence.terminal_result.auto_advance).toBe(false)
          expect(result.evidence.terminal_result.stop_reason).toBe(drift.stopReason)
          if (boundary.family === 'worker') {
            expect(after!.delivery_claimed_count).toBe(0)
          } else {
            expect(after!.delivery_claimed_count).toBe(1)
            expect(after!.reply_placement_count).toBe(0)
            expect(after!.handoff_accepted_count).toBe(
              drift.field === 'real_open_delivery_projection_drift' ? 1 : 0,
            )
          }
          for (const field of [
            'V1_message_queue_row_count', 'V1_agent_messages_row_count', 'V1_outbound_queue_row_count',
            'provider_attempt_count', 'provider_effect_count', 'external_send_attempt_count',
          ] as const) {
            expect(after![field]).toBe(before![field])
          }
        } finally {
          local.cleanup()
        }
      }, 10_000)
    }

    test(`positive protected boundary receipt ${boundary.family} accepts exact stage-owned progress`, async () => {
      const source = fixture()
      const local = await sqliteFixture()
      let observed = false
      let eventsAtBoundary = -1
      let closeCount = 0
      let at: ReceiptSnapshot | null = null
      let after: ReceiptSnapshot | null = null
      try {
        const result = await executeV2NativeStage(source.input, {
          seats: seats(source.binding),
          readDurableAuthority: durableAuthority(source),
          readOfflineState: () => offlineReadback(source.binding),
          openBoundDatabase: async () => local.db,
          readDatabaseState: readback,
          onMeshMutationBoundary: async currentBoundary => {
            if (!observed && currentBoundary === boundary.name) {
              observed = true
              eventsAtBoundary = await eventCount(local.db)
              at = await receiptSnapshot(local.db, source.binding)
            }
          },
          closeDatabase: async db => {
            closeCount += 1
            after = await receiptSnapshot(db, source.binding)
            await db.close()
          },
        })
        expect(observed).toBe(true)
        expect(result.ok).toBe(true)
        expect(result.result).toBe('MEASURED_PENDING_INDEPENDENT_GATES')
        expect(eventsAtBoundary).toBeGreaterThanOrEqual(0)
        expect(at).not.toBeNull()
        expect(after).not.toBeNull()
        expect(closeCount).toBe(1)
        expect(after!.active_turn_count).toBe(0)
        expect(after!.open_delivery_count).toBe(0)
        expect(result.evidence.terminal_result.auto_advance).toBe(false)
        for (const field of [
          'V1_message_queue_row_count', 'V1_agent_messages_row_count', 'V1_outbound_queue_row_count',
          'provider_attempt_count', 'provider_effect_count', 'external_send_attempt_count',
        ] as const) {
          expect(after![field]).toBe(0)
        }
      } finally {
        local.cleanup()
      }
    }, 15_000)
  }

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
