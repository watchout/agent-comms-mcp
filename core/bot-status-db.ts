/**
 * Issue #277 (D) — bot_status postgres truth.
 *
 * Single SQL that joins agents + message_queue and returns per-agent:
 *   - pending_count: pending message_queue rows
 *   - oldest_pending_at: oldest pending row created_at (NULL if none)
 *   - heartbeat_ok: agents.last_seen_at within 60s
 *   - health_state: derived enum
 *   - endpoint_lease_state: active connector runtime endpoint lease readiness
 *
 * `health_state` enum:
 *   - 'crashed'     — last_seen_at < NOW() - 5min
 *   - 'busy_stuck'  — status='busy' AND last_seen_at < NOW() - 2h
 *   - 'busy_active' — status='busy' AND last_seen_at within 60s
 *   - 'healthy'     — otherwise
 *
 * The SQL is deliberately a single statement (N+1 forbidden, perf budget < 100ms
 * per Issue #277 §2). Process-level health (registry / tmux / port) lives in
 * `core/bot-health.ts` and is composed at the caller (server.ts bot_status
 * handler).
 */
import type { Client } from 'pg'

export type BotHealthState =
  | 'healthy'
  | 'busy_active'
  | 'busy_stuck'
  | 'crashed'
  | 'offline'

export interface BotStatusDbRow {
  agent_id: string
  status: string | null
  last_seen_at: string | null
  heartbeat_ok: boolean
  pending_count: number
  oldest_pending_at: string | null
  active_claim_count: number
  typed_failed_count: number
  health_state: BotHealthState
  active_connector_count: number
  runtime_linked_connector_count: number
  active_endpoint_lease_count: number
  endpoint_lease_state: 'not_applicable' | 'missing_runtime' | 'missing_lease' | 'ok'
  endpoint_lease_expires_at: string | null
  endpoint_lease_heartbeat_at: string | null
}

const QUERY = `
  WITH queue_status AS (
    SELECT mq.agent_id,
           COUNT(mq.id) FILTER (WHERE mq.status = 'pending') AS pending_count,
           MIN(mq.created_at) FILTER (WHERE mq.status = 'pending') AS oldest_pending_at,
           COUNT(mq.id) FILTER (
             WHERE mq.status IN ('received', 'in_progress')
               AND mq.claimed_by = mq.agent_id
           ) AS active_claim_count,
           COUNT(mq.id) FILTER (
             WHERE mq.status = 'failed'
               AND mq.failed_reason IN ('WAKE_INVOCATION_RETRY_EXHAUSTED', 'QUEUE_WORK_RUNNER_ERROR_RETRY_EXHAUSTED')
           ) AS typed_failed_count
      FROM message_queue mq
     GROUP BY mq.agent_id
  ),
  endpoint_status AS (
    SELECT ci.agent_id,
           COUNT(DISTINCT ci.connector_instance_id) AS active_connector_count,
           COUNT(DISTINCT ci.connector_instance_id) FILTER (
             WHERE ci.runtime_instance_id IS NOT NULL
           ) AS runtime_linked_connector_count,
           COUNT(DISTINCT ci.connector_instance_id) FILTER (
             WHERE cpl.lease_id IS NOT NULL
           ) AS active_endpoint_lease_count,
           MIN(cpl.expires_at) AS endpoint_lease_expires_at,
           MAX(cpl.heartbeat_at) AS endpoint_lease_heartbeat_at
      FROM connector_instances ci
      LEFT JOIN control_plane_leases cpl
        ON cpl.lease_scope_type = 'runtime_instance'
       AND cpl.lease_scope_id = ci.runtime_instance_id::text
       AND cpl.status = 'active'
       AND cpl.expires_at > NOW()
     WHERE ci.status IN ('active')
     GROUP BY ci.agent_id
  )
  SELECT a.agent_id,
         a.status,
         a.last_seen_at,
         (a.last_seen_at > NOW() - INTERVAL '60 seconds') AS heartbeat_ok,
         COALESCE(q.pending_count, 0) AS pending_count,
         q.oldest_pending_at,
         COALESCE(q.active_claim_count, 0) AS active_claim_count,
         COALESCE(q.typed_failed_count, 0) AS typed_failed_count,
         CASE
           WHEN a.last_seen_at IS NULL THEN 'offline'
           -- Order matters: busy_stuck must be checked before crashed, otherwise
           -- a bot busy for >5min always falls into crashed first (auditor BLOCK
           -- fix, msg 55f54af5). The CASE arms are evaluated top-to-bottom so a
           -- busy bot never reaches the generic crashed arm; an idle bot that
           -- has not heartbeat in 5min still classifies as crashed.
           WHEN a.status = 'busy' AND a.last_seen_at < NOW() - INTERVAL '2 hours' THEN 'busy_stuck'
           WHEN a.last_seen_at < NOW() - INTERVAL '5 minutes' THEN 'crashed'
           WHEN a.status = 'busy' AND a.last_seen_at > NOW() - INTERVAL '60 seconds' THEN 'busy_active'
           ELSE 'healthy'
         END AS health_state,
         COALESCE(e.active_connector_count, 0) AS active_connector_count,
         COALESCE(e.runtime_linked_connector_count, 0) AS runtime_linked_connector_count,
         COALESCE(e.active_endpoint_lease_count, 0) AS active_endpoint_lease_count,
         CASE
           WHEN COALESCE(e.active_connector_count, 0) = 0 THEN 'not_applicable'
           WHEN COALESCE(e.runtime_linked_connector_count, 0) < COALESCE(e.active_connector_count, 0) THEN 'missing_runtime'
           WHEN COALESCE(e.active_endpoint_lease_count, 0) < COALESCE(e.active_connector_count, 0) THEN 'missing_lease'
           ELSE 'ok'
         END AS endpoint_lease_state,
         e.endpoint_lease_expires_at,
         e.endpoint_lease_heartbeat_at
    FROM agents a
    LEFT JOIN queue_status q ON q.agent_id = a.agent_id
    LEFT JOIN endpoint_status e ON e.agent_id = a.agent_id
`

function parseCount(value: string | number): number {
  return typeof value === 'string' ? parseInt(value, 10) : value
}

export async function fetchBotStatusFromDb(client: Client): Promise<Map<string, BotStatusDbRow>> {
  const result = await client.query<{
    agent_id: string
    status: string | null
    typed_failed_count: string | number
    last_seen_at: Date | null
    heartbeat_ok: boolean
    pending_count: string | number
    oldest_pending_at: Date | null
    active_claim_count: string | number
    health_state: BotHealthState
    active_connector_count: string | number
    runtime_linked_connector_count: string | number
    active_endpoint_lease_count: string | number
    endpoint_lease_state: BotStatusDbRow['endpoint_lease_state']
    endpoint_lease_expires_at: Date | null
    endpoint_lease_heartbeat_at: Date | null
  }>(QUERY)
  const map = new Map<string, BotStatusDbRow>()
  for (const row of result.rows) {
    map.set(row.agent_id, {
      agent_id: row.agent_id,
      status: row.status,
      typed_failed_count: parseCount(row.typed_failed_count),
      last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
      heartbeat_ok: Boolean(row.heartbeat_ok),
      pending_count: parseCount(row.pending_count),
      oldest_pending_at: row.oldest_pending_at ? row.oldest_pending_at.toISOString() : null,
      active_claim_count: parseCount(row.active_claim_count),
      health_state: row.health_state,
      active_connector_count: parseCount(row.active_connector_count),
      runtime_linked_connector_count: parseCount(row.runtime_linked_connector_count),
      active_endpoint_lease_count: parseCount(row.active_endpoint_lease_count),
      endpoint_lease_state: row.endpoint_lease_state,
      endpoint_lease_expires_at: row.endpoint_lease_expires_at ? row.endpoint_lease_expires_at.toISOString() : null,
      endpoint_lease_heartbeat_at: row.endpoint_lease_heartbeat_at ? row.endpoint_lease_heartbeat_at.toISOString() : null,
    })
  }
  return map
}

export function formatPendingAge(oldestPendingAt: string | null): string {
  if (!oldestPendingAt) return '0'
  const ageMs = Date.now() - new Date(oldestPendingAt).getTime()
  const sec = Math.floor(ageMs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h${min % 60}m`
}
