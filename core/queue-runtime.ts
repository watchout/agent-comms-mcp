export interface QueueDaemonStatusOptions {
  staleSeconds?: number
}

export interface QueueDaemonStatusReport {
  ok: true
  generated_at: string
  daemon: {
    liveness_source: 'message_queue_observation'
    last_wake_attempt_at: string | null
    last_claim_heartbeat_at: string | null
    note: string
  }
  queue: {
    status_counts: Record<string, number>
    pending_count: number
    active_claim_count: number
    expired_claim_count: number
    stale_pending_count: number
    retired_or_offline_pending_count: number
    oldest_pending_at: string | null
  }
}

export interface QueueSmokeReadiness {
  ok: true
  dry_run: true
  agent_id: string
  safe_to_execute: boolean
  blockers: string[]
  checks: {
    agent_exists: boolean
    pending_count: number
    active_claim_count: number
    expired_claim_count: number
  }
  execute_command: string
}

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null
  const d = new Date(value as any)
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value)
}

function formatSqlTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '+00')
}

async function oneNumber(db: Queryable, sql: string, params?: unknown[]): Promise<number> {
  const res = await db.query(sql, params)
  return Number(res.rows[0]?.count ?? res.rows[0]?.n ?? 0)
}

export async function buildQueueDaemonStatusReport(
  db: Queryable,
  options: QueueDaemonStatusOptions = {},
): Promise<QueueDaemonStatusReport> {
  const staleSeconds =
    Number.isFinite(options.staleSeconds) && (options.staleSeconds ?? 0) >= 0
      ? Number(options.staleSeconds)
      : 15 * 60
  const cutoff = formatSqlTimestamp(new Date(Date.now() - staleSeconds * 1000))

  const counts = await db.query(
    `SELECT status, count(*)::int AS count
       FROM message_queue
      GROUP BY status
      ORDER BY status`,
  )
  const aggregate = await db.query(
    `SELECT max(last_wake_attempt_at) AS last_wake_attempt_at,
            max(last_heartbeat_at) AS last_claim_heartbeat_at,
            min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
            count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            count(*) FILTER (WHERE status IN ('received', 'in_progress'))::int AS active_claim_count,
            count(*) FILTER (
              WHERE status IN ('received', 'in_progress')
                AND claim_expires_at IS NOT NULL
                AND claim_expires_at < now()
            )::int AS expired_claim_count,
            count(*) FILTER (
              WHERE status = 'pending'
                AND created_at < $1
            )::int AS stale_pending_count
       FROM message_queue`,
    [cutoff],
  )
  const retiredOrOffline = await oneNumber(
    db,
    `SELECT count(*)::int AS count
       FROM message_queue mq
       LEFT JOIN agents a ON a.agent_id = mq.agent_id
      WHERE mq.status = 'pending'
        AND (
          a.agent_id IS NULL
          OR a.status = 'offline'
          OR a.metadata->>'retired' = 'true'
        )`,
  )

  const agg = aggregate.rows[0] ?? {}
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    daemon: {
      liveness_source: 'message_queue_observation',
      last_wake_attempt_at: isoOrNull(agg.last_wake_attempt_at),
      last_claim_heartbeat_at: isoOrNull(agg.last_claim_heartbeat_at),
      note: 'state_daemon has no dedicated heartbeat table yet; this reports the latest DB-visible wake/claim heartbeat evidence.',
    },
    queue: {
      status_counts: counts.rows.reduce((acc: Record<string, number>, row: any) => {
        acc[row.status] = Number(row.count)
        return acc
      }, {}),
      pending_count: Number(agg.pending_count ?? 0),
      active_claim_count: Number(agg.active_claim_count ?? 0),
      expired_claim_count: Number(agg.expired_claim_count ?? 0),
      stale_pending_count: Number(agg.stale_pending_count ?? 0),
      retired_or_offline_pending_count: retiredOrOffline,
      oldest_pending_at: isoOrNull(agg.oldest_pending_at),
    },
  }
}

export async function buildQueueSmokeReadiness(
  db: Queryable,
  agentId: string,
): Promise<QueueSmokeReadiness> {
  const agent = await db.query(
    `SELECT agent_id FROM agents WHERE agent_id = $1 LIMIT 1`,
    [agentId],
  )
  const pending = await oneNumber(
    db,
    `SELECT count(*)::int AS count FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  )
  const active = await oneNumber(
    db,
    `SELECT count(*)::int AS count
       FROM message_queue
      WHERE agent_id = $1 AND status IN ('received', 'in_progress')`,
    [agentId],
  )
  const expired = await oneNumber(
    db,
    `SELECT count(*)::int AS count
       FROM message_queue
      WHERE agent_id = $1
        AND status IN ('received', 'in_progress')
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at < now()`,
    [agentId],
  )

  const blockers: string[] = []
  if (agent.rows.length === 0) blockers.push('agent_not_registered')
  if (active > 0) blockers.push('agent_has_active_claim')
  if (expired > 0) blockers.push('agent_has_expired_claim')

  return {
    ok: true,
    dry_run: true,
    agent_id: agentId,
    safe_to_execute: blockers.length === 0,
    blockers,
    checks: {
      agent_exists: agent.rows.length > 0,
      pending_count: pending,
      active_claim_count: active,
      expired_claim_count: expired,
    },
    execute_command: `agent-com queue smoke --agent-id ${agentId} --execute`,
  }
}
