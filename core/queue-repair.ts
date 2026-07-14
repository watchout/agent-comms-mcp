export type QueueRepairSample = {
  queue_id: string | number
  agent_id: string
  status: string
  message_id: string | null
  created_at: string | Date | null
  content: string | null
}

export type QueueRepairResult = {
  ok: true
  dry_run: boolean
  action: 'reassign' | 'close_obsolete' | 'reclaim_expired' | 'close_duplicates' | 'close_outbound_obsolete'
  affected_count: number
  sample_count: number
  sample_queue_ids: Array<string | number>
  samples: QueueRepairSample[]
  skipped_count?: number
  skipped_reason?: string
}

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

function samplesFromRows(rows: any[]): QueueRepairSample[] {
  return rows.map((row) => ({
    queue_id: row.id,
    agent_id: row.agent_id,
    status: row.status,
    message_id: row.message_id ?? null,
    created_at: row.created_at ?? null,
    content: row.content ?? null,
  }))
}

function result(action: QueueRepairResult['action'], dryRun: boolean, rows: any[]): QueueRepairResult {
  const samples = samplesFromRows(rows)
  return {
    ok: true,
    dry_run: dryRun,
    action,
    affected_count: Number(rows[0]?.total_count ?? rows.length),
    sample_count: rows.length,
    sample_queue_ids: rows.map((row) => row.id),
    samples,
  }
}

function statusCounts(rows: any[]): Record<string, number> {
  return rows.reduce((acc: Record<string, number>, row) => {
    const status = String(row.before_status ?? row.status ?? 'unknown')
    acc[status] = (acc[status] ?? 0) + 1
    return acc
  }, {})
}

function isRetiredAgent(row: any): boolean {
  const metadata = typeof row.metadata === 'string'
    ? (() => {
        try { return JSON.parse(row.metadata) } catch { return {} }
      })()
    : row.metadata ?? {}
  const retired = row.retired ?? metadata.retired
  return retired === true || retired === 'true'
}

function assertReassignTargetAvailable(row: any, agentId: string) {
  const status = String(row.status ?? '')
  const historicalOnly = row.historical_only === true || row.historical_only === 1 || row.historical_only === '1'
  const newWorkAllowed = row.new_work_allowed === undefined || row.new_work_allowed === null
    ? true
    : row.new_work_allowed === true || row.new_work_allowed === 1 || row.new_work_allowed === '1'
  const profileEnabled = row.profile_enabled === undefined || row.profile_enabled === null
    ? true
    : row.profile_enabled === true || row.profile_enabled === 1 || row.profile_enabled === '1'
  if (
    isRetiredAgent(row) ||
    historicalOnly ||
    !newWorkAllowed ||
    !profileEnabled ||
    row.disabled_at ||
    (status && !['online', 'idle', 'busy'].includes(status))
  ) {
    throw new Error(`QUEUE_REPAIR_TARGET_UNAVAILABLE:${agentId}:${status || 'unknown'}`)
  }
}

function parseDurationToSeconds(value: string): number {
  const m = /^(\d+)([mhd])$/.exec(value.trim())
  if (!m) return Number.NaN
  const n = Number(m[1])
  if (!Number.isFinite(n)) return Number.NaN
  const unit = m[2]
  if (unit === 'm') return n * 60
  if (unit === 'h') return n * 3600
  if (unit === 'd') return n * 86_400
  return Number.NaN
}

async function writeAuditLog(
  db: Queryable,
  eventType: string,
  agentId: string | null,
  target: string | null,
  detail: Record<string, unknown>,
) {
  await db.query(
    'INSERT INTO audit_log (event_type, agent_id, target, detail, org_id) VALUES ($1, $2, $3, $4, $5)',
    [eventType, agentId, target, JSON.stringify(detail), 'default'],
  )
}

export async function reassignPendingQueueRows(
  db: Queryable,
  input: { fromAgentId: string; toAgentId: string; dryRun?: boolean },
): Promise<QueueRepairResult> {
  const dryRun = input.dryRun ?? true
  if (input.fromAgentId === input.toAgentId) {
    throw new Error('QUEUE_REPAIR_SAME_AGENT')
  }

  const target = await db.query(
    "SELECT agent_id, status, metadata, metadata->>'retired' AS retired, profile_enabled, disabled_at, historical_only, new_work_allowed FROM agents WHERE agent_id = $1 LIMIT 1",
    [input.toAgentId],
  )
  if (target.rows.length === 0) {
    throw new Error(`QUEUE_REPAIR_TARGET_NOT_FOUND:${input.toAgentId}`)
  }
  assertReassignTargetAvailable(target.rows[0], input.toAgentId)

  const selectSql = `
    SELECT id, agent_id, status, message_id, created_at,
           count(*) OVER ()::int AS total_count,
           left(payload, 180) AS content
      FROM message_queue
     WHERE agent_id = $1
       AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT 50`

  if (dryRun) {
    const preview = await db.query(selectSql, [input.fromAgentId])
    const duplicate = await db.query(
      `SELECT id, agent_id, status, message_id, created_at,
              count(*) OVER ()::int AS total_count,
              left(payload, 180) AS content
         FROM message_queue mq
        WHERE agent_id = $1
          AND status = 'pending'
          AND message_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM message_queue target
             WHERE target.agent_id = $2
               AND target.message_id = mq.message_id
          )
        ORDER BY created_at ASC
        LIMIT 50`,
      [input.fromAgentId, input.toAgentId],
    )
    return {
      ...result('reassign', true, preview.rows),
      skipped_count: Number(duplicate.rows[0]?.total_count ?? duplicate.rows.length),
      skipped_reason: duplicate.rows.length > 0 ? 'target_already_has_message_id' : undefined,
    }
  }

  await db.query('BEGIN')
  try {
    const updated = await db.query(
      `WITH before AS (
         SELECT id, agent_id, status, message_id
           FROM message_queue
          WHERE agent_id = $1
            AND status = 'pending'
       ),
       moved AS (
         UPDATE message_queue mq
            SET agent_id = $2
           FROM before b
          WHERE mq.id = b.id
          RETURNING mq.id, mq.agent_id, mq.status, mq.message_id, mq.created_at,
                    b.agent_id AS before_agent_id,
                    b.status AS before_status,
                    left(mq.payload, 180) AS content
       )
       SELECT *, count(*) OVER ()::int AS total_count
         FROM moved
        ORDER BY created_at ASC
        LIMIT 50`,
      [input.fromAgentId, input.toAgentId],
    )
    await writeAuditLog(db, 'queue.reassign', input.fromAgentId, input.toAgentId, {
      from_agent_id: input.fromAgentId,
      to_agent_id: input.toAgentId,
      affected_count: Number(updated.rows[0]?.total_count ?? updated.rows.length),
      before_statuses: statusCounts(updated.rows),
      after_status: 'pending',
      after_agent_id: input.toAgentId,
      sample_queue_ids: updated.rows.map((row) => row.id),
    })
    await db.query('COMMIT')
    return result('reassign', false, updated.rows)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export async function closeObsoletePendingQueueRows(
  db: Queryable,
  input: {
    agentId: string
    reason: string
    dryRun?: boolean
    queueId?: string | number | null
    includeActive?: boolean
  },
): Promise<QueueRepairResult> {
  const dryRun = input.dryRun ?? true
  const reason = input.reason.trim()
  if (!reason) {
    throw new Error('QUEUE_REPAIR_REASON_REQUIRED')
  }
  if (input.includeActive && (input.queueId === undefined || input.queueId === null || String(input.queueId).trim() === '')) {
    throw new Error('QUEUE_REPAIR_INCLUDE_ACTIVE_REQUIRES_QUEUE_ID')
  }
  const failedReason = reason.startsWith('OBSOLETE') ? reason : `OBSOLETE:${reason}`
  const params: unknown[] = [input.agentId]
  const clauses = [`agent_id = $1`]
  if (input.includeActive) {
    clauses.push("status IN ('pending', 'received', 'in_progress')")
  } else {
    clauses.push("status = 'pending'")
  }
  if (input.queueId !== undefined && input.queueId !== null && String(input.queueId).trim() !== '') {
    params.push(input.queueId)
    clauses.push(`id = $${params.length}`)
  }
  const whereSql = clauses.join(' AND ')

  const selectSql = `
    SELECT id, agent_id, status, message_id, created_at,
           count(*) OVER ()::int AS total_count,
           left(payload, 180) AS content
      FROM message_queue
     WHERE ${whereSql}
     ORDER BY created_at ASC
     LIMIT 50`

  if (dryRun) {
    const preview = await db.query(selectSql, params)
    return result('close_obsolete', true, preview.rows)
  }

  await db.query('BEGIN')
  try {
    const failedReasonParam = params.length + 1
    const closed = await db.query(
      `WITH before AS (
         SELECT id, agent_id, status, message_id
           FROM message_queue
          WHERE ${whereSql}
       ),
       closed AS (
         UPDATE message_queue mq
            SET status = 'skipped',
                failed_reason = $${failedReasonParam},
                done_at = now(),
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
           FROM before b
          WHERE mq.id = b.id
          RETURNING mq.id, mq.agent_id, mq.status, mq.message_id, mq.created_at,
                    b.status AS before_status,
                    left(mq.payload, 180) AS content
       ),
       affected_agents AS (
         SELECT DISTINCT agent_id FROM closed
       ),
       agent_active_state AS (
         SELECT a.agent_id,
                EXISTS(SELECT 1 FROM message_queue mq WHERE mq.claimed_by = a.agent_id AND mq.status IN ('received', 'in_progress')) AS has_active_claims
           FROM agents a
           JOIN affected_agents aa ON aa.agent_id = a.agent_id
       ),
       refreshed_agents AS (
         UPDATE agents a SET
            status = CASE
              WHEN aas.has_active_claims AND a.status IN ('busy', 'idle') THEN 'busy'
              WHEN NOT aas.has_active_claims AND a.status = 'busy' THEN 'idle'
              ELSE a.status
            END,
            status_detail = CASE
              WHEN aas.has_active_claims AND a.status IN ('busy', 'idle') THEN 'message processing'
              WHEN NOT aas.has_active_claims AND a.status IN ('busy', 'idle') THEN NULL
              ELSE a.status_detail
            END,
            status_updated_at = now()
           FROM agent_active_state aas
          WHERE a.agent_id = aas.agent_id
          RETURNING a.agent_id
       )
       SELECT *, count(*) OVER ()::int AS total_count
         FROM closed
        ORDER BY created_at ASC
        LIMIT 50`,
      [...params, failedReason],
    )
    await writeAuditLog(db, 'queue.close_obsolete', input.agentId, input.agentId, {
      agent_id: input.agentId,
      queue_id: input.queueId ?? null,
      include_active: input.includeActive ?? false,
      reason: failedReason,
      affected_count: Number(closed.rows[0]?.total_count ?? closed.rows.length),
      before_statuses: statusCounts(closed.rows),
      after_status: 'skipped',
      sample_queue_ids: closed.rows.map((row) => row.id),
    })
    await db.query('COMMIT')
    return result('close_obsolete', false, closed.rows)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export async function reclaimExpiredQueueClaims(
  db: Queryable,
  input: { agentId?: string | null; dryRun?: boolean; queueId?: string | number | null } = {},
): Promise<QueueRepairResult> {
  const dryRun = input.dryRun ?? true
  const params: unknown[] = [input.agentId ?? null]
  let filter = ` AND ($1::text IS NULL OR agent_id = $1)`
  if (input.queueId !== undefined && input.queueId !== null && String(input.queueId).trim() !== '') {
    params.push(input.queueId)
    filter += ` AND id = $${params.length}`
  }

  const selectSql = `
    SELECT id, agent_id, status, message_id, created_at,
           count(*) OVER ()::int AS total_count,
           left(payload, 180) AS content
      FROM message_queue
     WHERE status IN ('received', 'in_progress')
       AND claim_expires_at IS NOT NULL
       AND claim_expires_at < now()
       ${filter}
     ORDER BY claim_expires_at ASC
     LIMIT 50`

  if (dryRun) {
    const preview = await db.query(selectSql, params)
    return result('reclaim_expired', true, preview.rows)
  }

  await db.query('BEGIN')
  try {
    const reclaimed = await db.query(
      `WITH before AS (
         SELECT id, agent_id, status, message_id
           FROM message_queue
          WHERE status IN ('received', 'in_progress')
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at < now()
            ${filter}
       ),
       reclaimed AS (
         UPDATE message_queue mq
            SET status = 'pending',
                read_at = NULL,
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
           FROM before b
          WHERE mq.id = b.id
          RETURNING mq.id, mq.agent_id, mq.status, mq.message_id, mq.created_at,
                    b.status AS before_status,
                    left(mq.payload, 180) AS content
       ),
       affected_agents AS (
         SELECT DISTINCT agent_id FROM reclaimed
       ),
       agent_active_state AS (
         SELECT a.agent_id,
                EXISTS(SELECT 1 FROM message_queue mq WHERE mq.claimed_by = a.agent_id AND mq.status IN ('received', 'in_progress')) AS has_active_claims
           FROM agents a
           JOIN affected_agents aa ON aa.agent_id = a.agent_id
       ),
       refreshed_agents AS (
         UPDATE agents a SET
            status = CASE
              WHEN aas.has_active_claims AND a.status IN ('busy', 'idle') THEN 'busy'
              WHEN NOT aas.has_active_claims AND a.status = 'busy' THEN 'idle'
              ELSE a.status
            END,
            status_detail = CASE
              WHEN aas.has_active_claims AND a.status IN ('busy', 'idle') THEN 'message processing'
              WHEN NOT aas.has_active_claims AND a.status IN ('busy', 'idle') THEN NULL
              ELSE a.status_detail
            END,
            status_updated_at = now()
           FROM agent_active_state aas
          WHERE a.agent_id = aas.agent_id
          RETURNING a.agent_id
       )
       SELECT *, count(*) OVER ()::int AS total_count
         FROM reclaimed
        ORDER BY created_at ASC
        LIMIT 50`,
      params,
    )
    await writeAuditLog(db, 'queue.reclaim_expired', input.agentId ?? null, input.agentId ?? null, {
      agent_id: input.agentId ?? null,
      affected_count: Number(reclaimed.rows[0]?.total_count ?? reclaimed.rows.length),
      before_statuses: statusCounts(reclaimed.rows),
      after_status: 'pending',
      sample_queue_ids: reclaimed.rows.map((row) => row.id),
    })
    await db.query('COMMIT')
    return result('reclaim_expired', false, reclaimed.rows)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export async function closeDuplicatePendingQueueRows(
  db: Queryable,
  input: { fromAgentId: string; toAgentId: string; reason: string; dryRun?: boolean },
): Promise<QueueRepairResult> {
  const dryRun = input.dryRun ?? true
  const reason = input.reason.trim()
  if (!reason) throw new Error('QUEUE_REPAIR_REASON_REQUIRED')

  const target = await db.query(
    "SELECT agent_id, status, metadata, metadata->>'retired' AS retired, profile_enabled, disabled_at, historical_only, new_work_allowed FROM agents WHERE agent_id = $1 LIMIT 1",
    [input.toAgentId],
  )
  if (target.rows.length === 0) throw new Error(`QUEUE_REPAIR_TARGET_NOT_FOUND:${input.toAgentId}`)
  assertReassignTargetAvailable(target.rows[0], input.toAgentId)

  const selectSql = `
    SELECT mq.id, mq.agent_id, mq.status, mq.message_id, mq.created_at,
           count(*) OVER ()::int AS total_count,
           left(mq.payload, 180) AS content
      FROM message_queue mq
     WHERE mq.agent_id = $1
       AND mq.status = 'pending'
       AND mq.message_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM message_queue target
          WHERE target.agent_id = $2
            AND target.message_id = mq.message_id
       )
     ORDER BY mq.created_at ASC
     LIMIT 50`

  if (dryRun) {
    const preview = await db.query(selectSql, [input.fromAgentId, input.toAgentId])
    return result('close_duplicates', true, preview.rows)
  }

  const failedReason = reason.startsWith('DUPLICATE') ? reason : `DUPLICATE:${reason}`
  await db.query('BEGIN')
  try {
    const closed = await db.query(
      `WITH before AS (
         SELECT mq.id, mq.agent_id, mq.status, mq.message_id
           FROM message_queue mq
          WHERE mq.agent_id = $1
            AND mq.status = 'pending'
            AND mq.message_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM message_queue target
               WHERE target.agent_id = $2
                 AND target.message_id = mq.message_id
            )
       ),
       closed AS (
         UPDATE message_queue mq
            SET status = 'skipped',
                failed_reason = $3,
                done_at = now(),
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
           FROM before b
          WHERE mq.id = b.id
          RETURNING mq.id, mq.agent_id, mq.status, mq.message_id, mq.created_at,
                    b.status AS before_status,
                    left(mq.payload, 180) AS content
       )
       SELECT *, count(*) OVER ()::int AS total_count
         FROM closed
        ORDER BY created_at ASC
        LIMIT 50`,
      [input.fromAgentId, input.toAgentId, failedReason],
    )
    await writeAuditLog(db, 'queue.close_duplicates', input.fromAgentId, input.toAgentId, {
      from_agent_id: input.fromAgentId,
      to_agent_id: input.toAgentId,
      reason: failedReason,
      affected_count: Number(closed.rows[0]?.total_count ?? closed.rows.length),
      before_statuses: statusCounts(closed.rows),
      after_status: 'skipped',
      sample_queue_ids: closed.rows.map((row) => row.id),
    })
    await db.query('COMMIT')
    return result('close_duplicates', false, closed.rows)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export async function closeObsoleteOutboundRows(
  db: Queryable,
  input: {
    agentId?: string | null
    consumerAgentId?: string | null
    reason: string
    maxAge?: string
    dryRun?: boolean
  },
): Promise<QueueRepairResult> {
  const dryRun = input.dryRun ?? true
  const reason = input.reason.trim()
  if (!reason) throw new Error('QUEUE_REPAIR_REASON_REQUIRED')
  const maxAgeSeconds = parseDurationToSeconds(input.maxAge ?? '12h')
  if (!Number.isFinite(maxAgeSeconds)) throw new Error(`QUEUE_REPAIR_INVALID_DURATION:${input.maxAge}`)

  const params: unknown[] = [maxAgeSeconds]
  const clauses = ["status = 'pending'", `created_at < now() - ($1 || ' seconds')::interval`]
  if (input.agentId) {
    params.push(input.agentId)
    clauses.push(`agent_id = $${params.length}`)
  }
  if (input.consumerAgentId) {
    params.push(input.consumerAgentId)
    clauses.push(`consumer_agent_id = $${params.length}`)
  }
  const whereSql = clauses.join(' AND ')
  const selectSql = `
    SELECT id, agent_id, status, message_id, created_at,
           count(*) OVER ()::int AS total_count,
           left(content, 180) AS content
      FROM outbound_queue
     WHERE ${whereSql}
     ORDER BY created_at ASC
     LIMIT 50`

  if (dryRun) {
    const preview = await db.query(selectSql, params)
    return result('close_outbound_obsolete', true, preview.rows)
  }

  const failedReason = reason.startsWith('OBSOLETE') ? reason : `OBSOLETE:${reason}`
  await db.query('BEGIN')
  try {
    const closed = await db.query(
      `WITH before AS (
         SELECT id, agent_id, status, message_id
           FROM outbound_queue
          WHERE ${whereSql}
       ),
       closed AS (
         UPDATE outbound_queue oq
            SET status = 'failed',
                failed_reason = $${params.length + 1},
                processed_at = now()
           FROM before b
          WHERE oq.id = b.id
          RETURNING oq.id, oq.agent_id, oq.status, oq.message_id, oq.created_at,
                    b.status AS before_status,
                    left(oq.content, 180) AS content
       )
       SELECT *, count(*) OVER ()::int AS total_count
         FROM closed
        ORDER BY created_at ASC
        LIMIT 50`,
      [...params, failedReason],
    )
    await writeAuditLog(db, 'queue.close_outbound_obsolete', input.agentId ?? null, input.consumerAgentId ?? null, {
      agent_id: input.agentId ?? null,
      consumer_agent_id: input.consumerAgentId ?? null,
      reason: failedReason,
      affected_count: Number(closed.rows[0]?.total_count ?? closed.rows.length),
      before_statuses: statusCounts(closed.rows),
      after_status: 'failed',
      sample_queue_ids: closed.rows.map((row) => row.id),
    })
    await db.query('COMMIT')
    return result('close_outbound_obsolete', false, closed.rows)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export const _internal = {
  parseDurationToSeconds,
}
