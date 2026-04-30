/**
 * Issue #277 (D) — bot_status postgres truth.
 *
 * Single SQL that joins agents + message_queue and returns per-agent:
 *   - pending_count: pending message_queue rows
 *   - oldest_pending_at: oldest pending row created_at (NULL if none)
 *   - heartbeat_ok: agents.last_seen_at within 60s
 *   - health_state: derived enum
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
  health_state: BotHealthState
}

const QUERY = `
  SELECT a.agent_id,
         a.status,
         a.last_seen_at,
         (a.last_seen_at > NOW() - INTERVAL '60 seconds') AS heartbeat_ok,
         COUNT(mq.id) FILTER (WHERE mq.status = 'pending') AS pending_count,
         MIN(mq.created_at) FILTER (WHERE mq.status = 'pending') AS oldest_pending_at,
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
         END AS health_state
    FROM agents a
    LEFT JOIN message_queue mq ON mq.agent_id = a.agent_id
   GROUP BY a.agent_id, a.status, a.last_seen_at
`

export async function fetchBotStatusFromDb(client: Client): Promise<Map<string, BotStatusDbRow>> {
  const result = await client.query<{
    agent_id: string
    status: string | null
    last_seen_at: Date | null
    heartbeat_ok: boolean
    pending_count: string | number
    oldest_pending_at: Date | null
    health_state: BotHealthState
  }>(QUERY)
  const map = new Map<string, BotStatusDbRow>()
  for (const row of result.rows) {
    map.set(row.agent_id, {
      agent_id: row.agent_id,
      status: row.status,
      last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
      heartbeat_ok: row.heartbeat_ok,
      pending_count: typeof row.pending_count === 'string' ? parseInt(row.pending_count, 10) : row.pending_count,
      oldest_pending_at: row.oldest_pending_at ? row.oldest_pending_at.toISOString() : null,
      health_state: row.health_state,
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
