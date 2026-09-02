// CELL-4MCP-AUN-001 — routing-profile store + SuiteEvent/v1 producer.
//
// Every mutation of aun_agent_routing_profiles commits atomically with its
// SuiteEvent appended to EventLogCore — the SINGLE event path (no parallel
// emitter, no side-door writes). AUN is the suite identity minting
// authority (Contract C v0.2): only the registration path here may create
// an identity for an unseen agent_id; any other first-upsert fails closed
// with NotMintedError and creates no row.
//
// SuiteEvent required fields (contract): event_id / correlation_id /
// causation_id / occurred_at live on EventLogCore columns; producer_mcp /
// contract_version / subject.agent_id / source_ref / payload_schema /
// payload_hash / row_version travel in the payload. row_version is derived
// from the subject's event count inside the transaction (Contract B's
// frozen column list has no row_version column — design_judgment recorded
// in the PR), so it is strictly monotonic per agent_id and the events
// support the consumer-side (occurred_at, row_version) guard.

import { createHash } from 'node:crypto'
import type { DbAdapter } from '../db/adapter'
import { EventLog } from '../eventlog/store'
import type { EventType, StoredEvent } from '../eventlog/types'
import { ensureRoutingProfilesSchema } from './schema'

export const SUITE_CONTRACT_VERSION = 'SPEC-4MCP-002/v0.2'
export const PRODUCER_MCP = 'aun'
export const ROUTING_PROFILE_PAYLOAD_SCHEMA = 'aun_routing_profile/v1'

export const SUITE_EVENT_TYPES: EventType[] = [
  'suite.identity.agent_upserted',
  'suite.identity.agent_deactivated',
  'suite.identity.agent_retired',
  'suite.mcp_profile.aun_routing_changed',
]

export class NotMintedError extends Error {
  code = 'NOT_MINTED' as const
}
export class RegisterConflictError extends Error {
  code = 'REGISTER_CONFLICT' as const
}
export class RetiredAgentError extends Error {
  code = 'AGENT_RETIRED' as const
}

export interface RoutingProfileRow {
  agent_id: string
  routing_status: string
  delivery_targets_json: string
  channel_bindings_json: string
  queue_visibility: string
  routing_source_ref: string | null
  updated_at: string
}

export interface RoutingProfileInput {
  agentId: string
  deliveryTargets?: unknown[]
  channelBindings?: unknown[]
  queueVisibility?: string
  /** Control ref for this change (dispatch anchor, decision URL, …). */
  sourceRef: string
  /** Acting seat identity for the event envelope. */
  seatId?: string
  seatInstanceId?: string
}

/** Deterministic per-subject event stream id (EventLogCore conversation). */
export function subjectStream(agentId: string): string {
  return `suite:${PRODUCER_MCP}:agent:${agentId}`
}

export function suiteEventId(agentId: string, rowVersion: number): string {
  return `suite:${PRODUCER_MCP}:${agentId}:v${rowVersion}`
}

function profileSnapshot(row: {
  agent_id: string
  routing_status: string
  delivery_targets_json: string
  channel_bindings_json: string
  queue_visibility: string
  routing_source_ref: string | null
}) {
  return {
    agent_id: row.agent_id,
    routing_status: row.routing_status,
    delivery_targets: JSON.parse(row.delivery_targets_json),
    channel_bindings: JSON.parse(row.channel_bindings_json),
    queue_visibility: row.queue_visibility,
    routing_source_ref: row.routing_source_ref,
  }
}

function payloadHash(snapshot: unknown): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export async function ensureSchema(db: DbAdapter): Promise<void> {
  await ensureRoutingProfilesSchema(db)
  await new EventLog(db).ensureSchema()
}

export async function getRoutingProfile(db: DbAdapter, agentId: string): Promise<RoutingProfileRow | null> {
  return db.queryOne<RoutingProfileRow>(
    'SELECT * FROM aun_agent_routing_profiles WHERE agent_id = $1',
    [agentId],
  )
}

export async function listRoutingProfiles(db: DbAdapter): Promise<RoutingProfileRow[]> {
  return db.query<RoutingProfileRow>(
    'SELECT * FROM aun_agent_routing_profiles ORDER BY agent_id ASC',
  )
}

async function nextRowVersion(tx: DbAdapter, agentId: string): Promise<{ rowVersion: number; priorEventId: string | null }> {
  const typeParams = SUITE_EVENT_TYPES.map((_, i) => `$${i + 2}`).join(', ')
  const rows = await tx.query<{ event_id: string }>(
    `SELECT event_id FROM event_log
     WHERE conversation_id = $1 AND event_type IN (${typeParams})
     ORDER BY seq DESC`,
    [subjectStream(agentId), ...SUITE_EVENT_TYPES],
  )
  return { rowVersion: rows.length + 1, priorEventId: rows[0]?.event_id ?? null }
}

async function appendSuiteEvent(
  tx: DbAdapter,
  input: {
    eventType: EventType
    agentId: string
    rowVersion: number
    priorEventId: string | null
    snapshot: ReturnType<typeof profileSnapshot>
    sourceRef: string
    seatId?: string
    seatInstanceId?: string
  },
) {
  const log = new EventLog(tx)
  return log.append(
    {
      eventId: suiteEventId(input.agentId, input.rowVersion),
      eventType: input.eventType,
      seatId: input.seatId ?? PRODUCER_MCP,
      seatInstanceId: input.seatInstanceId ?? null,
      conversationId: subjectStream(input.agentId),
      correlationId: subjectStream(input.agentId),
      causationId: input.priorEventId,
      payload: {
        producer_mcp: PRODUCER_MCP,
        contract_version: SUITE_CONTRACT_VERSION,
        subject: { agent_id: input.agentId },
        source_ref: input.sourceRef,
        payload_schema: ROUTING_PROFILE_PAYLOAD_SCHEMA,
        payload_hash: payloadHash(input.snapshot),
        row_version: input.rowVersion,
        profile: input.snapshot,
      },
    },
    tx,
  )
}

/**
 * Identity minting (the ONLY path that may create an unseen agent_id).
 * Emits suite.identity.agent_upserted at row_version 1.
 * Idempotent: an identical retry changes nothing and appends nothing
 * (deterministic event_id). A re-register with a DIFFERENT profile is a
 * conflict, not a silent overwrite.
 */
export async function registerAgentRoutingProfile(db: DbAdapter, input: RoutingProfileInput) {
  return db.transaction(async tx => {
    const existing = await getRoutingProfile(tx, input.agentId)
    const desired = {
      agent_id: input.agentId,
      routing_status: 'active',
      delivery_targets_json: JSON.stringify(input.deliveryTargets ?? []),
      channel_bindings_json: JSON.stringify(input.channelBindings ?? []),
      queue_visibility: input.queueVisibility ?? 'default',
      routing_source_ref: input.sourceRef,
    }
    if (existing) {
      const same =
        existing.routing_status === desired.routing_status &&
        existing.delivery_targets_json === desired.delivery_targets_json &&
        existing.channel_bindings_json === desired.channel_bindings_json &&
        existing.queue_visibility === desired.queue_visibility &&
        existing.routing_source_ref === desired.routing_source_ref
      if (!same) {
        throw new RegisterConflictError(
          `agent ${input.agentId} is already minted with a different profile; use updateAgentRoutingProfile`,
        )
      }
      return { minted: false, profile: existing }
    }
    await tx.execute(
      `INSERT INTO aun_agent_routing_profiles
         (agent_id, routing_status, delivery_targets_json, channel_bindings_json, queue_visibility, routing_source_ref)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [desired.agent_id, desired.routing_status, desired.delivery_targets_json,
       desired.channel_bindings_json, desired.queue_visibility, desired.routing_source_ref],
    )
    await appendSuiteEvent(tx, {
      eventType: 'suite.identity.agent_upserted',
      agentId: input.agentId,
      rowVersion: 1,
      priorEventId: null,
      snapshot: profileSnapshot(desired),
      sourceRef: input.sourceRef,
      seatId: input.seatId,
      seatInstanceId: input.seatInstanceId,
    })
    return { minted: true, profile: await getRoutingProfile(tx, input.agentId) }
  })
}

/**
 * Routing change for an EXISTING agent. A first-upsert through here is the
 * non-authority path and fails closed (Contract C v0.2 negative fixture):
 * no row is created, no event is appended.
 */
export async function updateAgentRoutingProfile(db: DbAdapter, input: RoutingProfileInput) {
  return db.transaction(async tx => {
    const existing = await getRoutingProfile(tx, input.agentId)
    if (!existing) {
      throw new NotMintedError(
        `agent ${input.agentId} has no identity row; first-upsert is reserved for the minting authority (registerAgentRoutingProfile)`,
      )
    }
    if (existing.routing_status === 'retired') {
      throw new RetiredAgentError(`agent ${input.agentId} is retired; profile is frozen`)
    }
    const desired = {
      agent_id: input.agentId,
      routing_status: existing.routing_status,
      delivery_targets_json: JSON.stringify(input.deliveryTargets ?? JSON.parse(existing.delivery_targets_json)),
      channel_bindings_json: JSON.stringify(input.channelBindings ?? JSON.parse(existing.channel_bindings_json)),
      queue_visibility: input.queueVisibility ?? existing.queue_visibility,
      routing_source_ref: input.sourceRef,
    }
    const unchanged =
      existing.delivery_targets_json === desired.delivery_targets_json &&
      existing.channel_bindings_json === desired.channel_bindings_json &&
      existing.queue_visibility === desired.queue_visibility &&
      existing.routing_source_ref === desired.routing_source_ref
    if (unchanged) {
      return { changed: false, profile: existing }
    }
    await tx.execute(
      `UPDATE aun_agent_routing_profiles
       SET delivery_targets_json = $2, channel_bindings_json = $3,
           queue_visibility = $4, routing_source_ref = $5,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE agent_id = $1`,
      [desired.agent_id, desired.delivery_targets_json, desired.channel_bindings_json,
       desired.queue_visibility, desired.routing_source_ref],
    )
    const { rowVersion, priorEventId } = await nextRowVersion(tx, input.agentId)
    await appendSuiteEvent(tx, {
      eventType: 'suite.mcp_profile.aun_routing_changed',
      agentId: input.agentId,
      rowVersion,
      priorEventId,
      snapshot: profileSnapshot(desired),
      sourceRef: input.sourceRef,
      seatId: input.seatId,
      seatInstanceId: input.seatInstanceId,
    })
    return { changed: true, profile: await getRoutingProfile(tx, input.agentId) }
  })
}

async function transitionStatus(
  db: DbAdapter,
  input: { agentId: string; sourceRef: string; seatId?: string; seatInstanceId?: string },
  status: 'disabled' | 'retired',
  eventType: EventType,
) {
  return db.transaction(async tx => {
    const existing = await getRoutingProfile(tx, input.agentId)
    if (!existing) throw new NotMintedError(`agent ${input.agentId} has no identity row`)
    if (existing.routing_status === 'retired') {
      throw new RetiredAgentError(`agent ${input.agentId} is retired; lifecycle is terminal`)
    }
    if (existing.routing_status === status) return { changed: false, profile: existing }
    await tx.execute(
      `UPDATE aun_agent_routing_profiles
       SET routing_status = $2, routing_source_ref = $3,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE agent_id = $1`,
      [input.agentId, status, input.sourceRef],
    )
    const updated = (await getRoutingProfile(tx, input.agentId))!
    const { rowVersion, priorEventId } = await nextRowVersion(tx, input.agentId)
    await appendSuiteEvent(tx, {
      eventType,
      agentId: input.agentId,
      rowVersion,
      priorEventId,
      snapshot: profileSnapshot(updated),
      sourceRef: input.sourceRef,
      seatId: input.seatId,
      seatInstanceId: input.seatInstanceId,
    })
    return { changed: true, profile: updated }
  })
}

export async function deactivateAgentRoutingProfile(
  db: DbAdapter,
  input: { agentId: string; sourceRef: string; seatId?: string; seatInstanceId?: string },
) {
  return transitionStatus(db, input, 'disabled', 'suite.identity.agent_deactivated')
}

export async function retireAgentRoutingProfile(
  db: DbAdapter,
  input: { agentId: string; sourceRef: string; seatId?: string; seatInstanceId?: string },
) {
  return transitionStatus(db, input, 'retired', 'suite.identity.agent_retired')
}

/** Suite events for a subject, in replay order (consumer-facing read). */
export async function suiteEventsFor(db: DbAdapter, agentId: string): Promise<StoredEvent[]> {
  return db.query<StoredEvent>(
    `SELECT * FROM event_log WHERE conversation_id = $1 ORDER BY seq ASC`,
    [subjectStream(agentId)],
  )
}

/**
 * Rebuild the whole table from the log (EventLogCore discipline: local
 * state is a projection). Every suite event carries the full profile
 * snapshot, so replaying the latest event per subject reproduces the table.
 */
export async function rebuildRoutingProfilesFromLog(db: DbAdapter): Promise<number> {
  const events = await db.query<StoredEvent>(
    `SELECT * FROM event_log
     WHERE event_type IN (${SUITE_EVENT_TYPES.map((_, i) => `$${i + 1}`).join(', ')})
     ORDER BY seq ASC`,
    [...SUITE_EVENT_TYPES],
  )
  const latest = new Map<string, { snapshot: any; updatedAt: string }>()
  for (const event of events) {
    const payload = JSON.parse(event.payload)
    latest.set(payload.subject.agent_id, { snapshot: payload.profile, updatedAt: event.occurred_at })
  }
  return db.transaction(async tx => {
    for (const [agentId, { snapshot, updatedAt }] of latest) {
      await tx.execute(
        `INSERT INTO aun_agent_routing_profiles
           (agent_id, routing_status, delivery_targets_json, channel_bindings_json,
            queue_visibility, routing_source_ref, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(agent_id) DO UPDATE SET
           routing_status = $2, delivery_targets_json = $3, channel_bindings_json = $4,
           queue_visibility = $5, routing_source_ref = $6, updated_at = $7`,
        [agentId, snapshot.routing_status, JSON.stringify(snapshot.delivery_targets),
         JSON.stringify(snapshot.channel_bindings), snapshot.queue_visibility,
         snapshot.routing_source_ref, updatedAt],
      )
    }
    return latest.size
  })
}
