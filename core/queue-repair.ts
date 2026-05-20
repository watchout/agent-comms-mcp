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
  action: 'reassign' | 'close_obsolete' | 'reclaim_expired'
  affected_count: number
  sample_count: number
  sample_queue_ids: Array<string | number>
  samples: QueueRepairSample[]
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
  const retired = row.retired ?? row.metadata?.retired
  return retired === true || retired === 'true'
}

function assertReassignTargetAvailable(row: any, agentId: string) {
  const status = String(row.status ?? '')
  if (isRetiredAgent(row) || !['online', 'idle', 'busy'].includes(status)) {
    throw new Error(`QUEUE_REPAIR_TARGET_UNAVAILABLE:${agentId}:${status || 'unknown'}`)
  }
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
    "SELECT agent_id, status, metadata, metadata->>'retired' AS retired FROM agents WHERE agent_id = $1 LIMIT 1",
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
    return result('reassign', true, preview.rows)
  }

  await db.query('BEGIN')
  try {
    const updated = await db.query(
      `WITH moved AS (
         UPDATE message_queue
            SET agent_id = $2
          WHERE agent_id = $1
            AND status = 'pending'
          RETURNING id, agent_id, status, message_id, created_at, left(payload, 180) AS content
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
       refreshed_agents AS (
         UPDATE agents a SET
            status = CASE WHEN EXISTS(SELECT 1 FROM message_queue mq WHERE mq.claimed_by = a.agent_id AND mq.status IN ('received', 'in_progress')) THEN 'busy' ELSE 'idle' END,
            status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue mq WHERE mq.claimed_by = a.agent_id AND mq.status IN ('received', 'in_progress')) THEN 'message processing' ELSE NULL END,
            status_updated_at = now()
          WHERE a.agent_id IN (SELECT DISTINCT agent_id FROM closed)
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
  input: { agentId?: string | null; dryRun?: boolean } = {},
): Promise<QueueRepairResult> {
  const dryRun = input.dryRun ?? true
  const agentFilter = input.agentId ? ' AND agent_id = $1' : ''
  const params = input.agentId ? [input.agentId] : []

  const selectSql = `
    SELECT id, agent_id, status, message_id, created_at,
           count(*) OVER ()::int AS total_count,
           left(payload, 180) AS content
      FROM message_queue
     WHERE status IN ('received', 'in_progress')
       AND claim_expires_at IS NOT NULL
       AND claim_expires_at < now()
       ${agentFilter}
     ORDER BY claim_expires_at ASC
     LIMIT 50`

  if (dryRun) {
    const preview = await db.query(selectSql, params)
    return result('reclaim_expired', true, preview.rows)
  }

  await db.query('BEGIN')
  try {
    const reclaimed = await db.query(
      `WITH reclaimed AS (
         UPDATE message_queue
            SET status = 'pending',
                read_at = NULL,
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
          WHERE status IN ('received', 'in_progress')
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at < now()
            ${agentFilter}
          RETURNING id, agent_id, status, message_id, created_at, left(payload, 180) AS content
       ),
       refreshed_agents AS (
         UPDATE agents a SET
            status = CASE WHEN EXISTS(SELECT 1 FROM message_queue mq WHERE mq.claimed_by = a.agent_id AND mq.status IN ('received', 'in_progress')) THEN 'busy' ELSE 'idle' END,
            status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue mq WHERE mq.claimed_by = a.agent_id AND mq.status IN ('received', 'in_progress')) THEN 'message processing' ELSE NULL END,
            status_updated_at = now()
          WHERE a.agent_id IN (SELECT DISTINCT agent_id FROM reclaimed)
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
      sample_queue_ids: reclaimed.rows.map((row) => row.id),
    })
    await db.query('COMMIT')
    return result('reclaim_expired', false, reclaimed.rows)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}
