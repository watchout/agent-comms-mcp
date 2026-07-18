import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { PgAdapter } from '../../core/db/pg-adapter'
import {
  ensureEventLogSchema,
  frozenEnabledSetSha256,
  openTurnCount,
  parseEventPayload,
  pendingV2NativeInternalHandoffs,
  routeV2NativeMessage,
  runtimeSnapshotSha256,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog'
import { deterministicV2NativeMeshRuntime } from '../../core/eventlog/runtimes'
import { runV2NativeMeshTick, type TurnRuntime, type V2NativeMeshSeatBinding } from '../../core/eventlog/worker'

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
const ROOT = resolve(import.meta.dir, '../..')
const K1_UP = readFileSync(resolve(ROOT, 'db/migrations/2026-07-16-aun-k1-event-projection-claim.up.sql'), 'utf8')
const K2_UP = readFileSync(resolve(ROOT, 'db/migrations/2026-07-16-aun-k2-runtime-supervision.up.sql'), 'utf8')

const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta', 'delta', 'gamma'].map((agent, index) => ({
  agent_id: agent,
  profile_revision: '1',
  runtime_engine: 'deterministic-k3',
  runtime_instance_id: `k3-fixture-${agent}`,
  runtime_checkout_root: `/fixture/${agent}`,
  runtime_checkout_sha: String(index + 1).repeat(40),
}))

function postgresFixtureEnabled(): boolean {
  return process.env.AUN_K3_DB_SCOPE === 'isolated_disposable_fixture'
}

async function createPostgresFixture(label: string) {
  const url = process.env.AUN_K3_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K3_TEST_DATABASE_URL is required')
  const databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!databaseName.startsWith('aun_k3_fixture_')) throw new Error(`unsafe K3 fixture database ${databaseName}`)
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== url) throw new Error('DATABASE_URL must equal AUN_K3_TEST_DATABASE_URL')
  const schema = `k3_${label}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const db = new PgAdapter(url)
  await db.execute(`CREATE SCHEMA "${schema}"`)
  await db.execute(`SET search_path TO "${schema}", public`)
  await db.execute(EVENT_LOG_DDL)
  await db.execute(K1_UP)
  await db.execute(K2_UP)
  return { db, async cleanup() { await db.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.close() } }
}

function scope(databaseIdentity: string): V2NativeMeshScopeV1 {
  return {
    schema_version: 'aun-v2-native-mesh-scope/v1',
    run_id: 'k3-frozen-n4-matrix',
    stage_id: 'S0_IMPLEMENTATION',
    repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: '0'.repeat(40),
    database_identity: databaseIdentity,
    frozen_enabled_set: agents,
    frozen_enabled_set_sha256: frozenEnabledSetSha256(agents),
    runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    deadline_ms: Date.now() + 30_000,
  }
}

function fence(value: V2NativeMeshScopeV1): V2NativeMeshExecutionFence {
  return {
    stage_id: 'S0_IMPLEMENTATION',
    exact_implementation_head: value.exact_implementation_head,
    database_identity: value.database_identity,
    runtime_snapshot_sha256: value.runtime_snapshot_sha256,
  }
}

function boundSeat(seatId: string, runtime: TurnRuntime): V2NativeMeshSeatBinding {
  const agent = agents.find(candidate => candidate.agent_id === seatId)
  if (!agent) throw new Error(`fixture agent ${seatId} not found`)
  return {
    seatId,
    runtime,
    runtimeInstanceId: agent.runtime_instance_id,
    runtimeCheckoutRoot: agent.runtime_checkout_root,
    runtimeCheckoutSha: agent.runtime_checkout_sha,
  }
}

function routeKey(payload: Record<string, unknown>): string {
  return `${String(payload.source_agent_id)}->${String(payload.recipient_agent_id)}`
}

async function runFrozenN4Matrix(db: DbAdapter, databaseIdentity: string) {
  const value = scope(databaseIdentity)
  const executionFence = fence(value)
  const ids = agents.map(agent => agent.agent_id)
  const expectedDirected = new Set<string>()
  const expectedFanout = new Set<string>()
  const expectedCorrelatedReplies = new Set<string>()

  for (const source of ids) {
    const recipients = ids.filter(id => id !== source)
    for (const recipient of recipients) {
      expectedDirected.add(`${source}->${recipient}`)
      expectedCorrelatedReplies.add(`${recipient}->${source}`)
      await routeV2NativeMessage(db, value, executionFence, {
        route_id: `direct:${source}:${recipient}`,
        route_kind: 'direct',
        source_agent_id: source,
        recipient_agent_ids: [recipient],
        content: `direct-request:${source}:${recipient}`,
      })
    }
    for (const recipient of recipients) expectedFanout.add(`${source}->${recipient}`)
    await routeV2NativeMessage(db, value, executionFence, {
      route_id: `fanout:${source}`,
      route_kind: 'fanout',
      source_agent_id: source,
      recipient_agent_ids: recipients,
      content: `fanout-observation:${source}`,
    })
  }

  const runtime = deterministicV2NativeMeshRuntime(({ seatId, sourceAgentId, content }) =>
    content.startsWith('direct-request:') ? `correlated-reply:${seatId}:${sourceAgentId}` : null,
  )
  const seats = ids.map(seatId => boundSeat(seatId, runtime))
  let guard = 0
  while ((await openTurnCount(db)) > 0 || (await pendingV2NativeInternalHandoffs(db, value, executionFence)).length > 0) {
    await runV2NativeMeshTick(db, { scope: value, fence: executionFence, seats, instanceId: `k3-matrix-${guard}` })
    if (++guard > 12) throw new Error('K3 frozen N=4 matrix did not converge')
  }

  const received = (await db.query<{ payload: unknown }>(
    "SELECT payload FROM event_log WHERE event_type='message.received' ORDER BY seq",
  )).map(row => parseEventPayload<Record<string, unknown>>(row.payload))
  const direct = received.filter(payload => payload.route_kind === 'direct').map(routeKey)
  const fanout = received.filter(payload => payload.route_kind === 'fanout_child').map(routeKey)
  const replies = received.filter(payload => payload.route_kind === 'reply').map(routeKey)
  const fanoutParents = (await db.query<{ payload: unknown }>(
    "SELECT payload FROM event_log WHERE event_type='message.route_planned'",
  )).map(row => parseEventPayload<Record<string, unknown>>(row.payload))
    .filter(payload => payload.route_kind === 'fanout').length
  const terminalReplies = Number((await db.queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.handoff_accepted'",
  ))?.n ?? 0)
  const duplicateTerminals = Number((await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT reply_id FROM event_log WHERE event_type='reply.handoff_accepted'
        GROUP BY reply_id HAVING COUNT(*) > 1
     ) duplicates`,
  ))?.n ?? 0)
  const providerEvents = Number((await db.queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM event_log WHERE event_type IN ('reply.provider_nonce_reserved','reply.provider_invocation_started','reply.delivered')",
  ))?.n ?? 0)

  const actualDirected = new Set(direct)
  const actualFanout = new Set(fanout)
  const actualReplies = new Set(replies)
  const missing = [...expectedDirected].filter(key => !actualDirected.has(key)).length
    + [...expectedFanout].filter(key => !actualFanout.has(key)).length
    + [...expectedCorrelatedReplies].filter(key => !actualReplies.has(key)).length
  const duplicates = direct.length - actualDirected.size + fanout.length - actualFanout.size
    + replies.length - actualReplies.size + duplicateTerminals
  const unexpectedRecipients = [...actualDirected].filter(key => !expectedDirected.has(key)).length
    + [...actualFanout].filter(key => !expectedFanout.has(key)).length
    + [...actualReplies].filter(key => !expectedCorrelatedReplies.has(key)).length

  return {
    directed_requests: direct.length,
    terminal_replies: terminalReplies,
    fanout_parents: fanoutParents,
    fanout_children: fanout.length,
    missing,
    duplicates,
    unexpected_recipients: unexpectedRecipients,
    open_turns_after_drain: await openTurnCount(db),
    pending_internal_deliveries_after_drain: (await pendingV2NativeInternalHandoffs(db, value, executionFence)).length,
    correlated_reply_placements: replies.length,
    provider_events: providerEvents,
    V1_invocations: 0,
  }
}

const expectedMatrix = {
  directed_requests: 12,
  terminal_replies: 12,
  fanout_parents: 4,
  fanout_children: 12,
  missing: 0,
  duplicates: 0,
  unexpected_recipients: 0,
  open_turns_after_drain: 0,
  pending_internal_deliveries_after_drain: 0,
  correlated_reply_placements: 12,
  provider_events: 0,
  V1_invocations: 0,
}

describe('K3 matrix evidence', () => {
  test('TC014 frozen N=4 direct/fanout/correlated reply matrix has exact formulas and zero residuals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-k3-matrix-'))
    const db = new SqliteAdapter(join(dir, 'eventlog.db'))
    await ensureEventLogSchema(db)
    try {
      expect(await runFrozenN4Matrix(db, 'sqlite:isolated:k3-n4-matrix')).toEqual(expectedMatrix)
    } finally {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.if(postgresFixtureEnabled())('K3 disposable PostgreSQL matrix evidence', () => {
  test('TC014-PG frozen N=4 direct/fanout/correlated reply formulas hold on PostgreSQL', async () => {
    const pg = await createPostgresFixture('matrix')
    try {
      expect(await runFrozenN4Matrix(pg.db, 'postgres:isolated:k3-n4-matrix')).toEqual(expectedMatrix)
    } finally { await pg.cleanup() }
  })
})
