import { evaluateDoneTransition, formatDoneTransitionRejection, type TerminalBatonDecision } from './terminal-baton-invariant'

export type LifecycleTransitionMode = 'processing' | 'done'

export type LifecycleTransitionStatus = 'in_progress' | 'done'

export type LifecycleTransitionDb = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>
}

export type LifecycleTransitionResult =
  | {
      ok: true
      queue_id: string | number
      agent_id: string
      message_id: string | null
      status: LifecycleTransitionStatus
      already_transitioned?: true
    }
  | {
      ok: false
      code: 'NOT_FOUND' | 'INVALID_STATE' | 'RACE' | 'TERMINAL_BATON_REQUIRED'
      message: string
      observed?: string
      decision?: TerminalBatonDecision
    }

type QueueTransitionRow = {
  id: string | number
  agent_id: string
  message_id: string | null
  status: string
}

export function lifecycleTransitionStatuses(mode: LifecycleTransitionMode): {
  fromStatus: 'received' | 'in_progress'
  toStatus: LifecycleTransitionStatus
} {
  return mode === 'processing'
    ? { fromStatus: 'received', toStatus: 'in_progress' }
    : { fromStatus: 'in_progress', toStatus: 'done' }
}

export async function lifecycleTransitionCore(
  db: LifecycleTransitionDb,
  opts: {
    mode: LifecycleTransitionMode
    queueId: string | number
    agentId: string
    ownerAgentId?: string | null
  },
): Promise<LifecycleTransitionResult> {
  const { fromStatus, toStatus } = lifecycleTransitionStatuses(opts.mode)
  const ownerFilter = opts.ownerAgentId ? ' AND agent_id = $2' : ''
  const selectParams = opts.ownerAgentId ? [opts.queueId, opts.ownerAgentId] : [opts.queueId]
  const rows = await db.query<QueueTransitionRow>(
    `SELECT id, agent_id, message_id, status
       FROM message_queue
      WHERE id = $1${ownerFilter}`,
    selectParams,
  )
  const row = rows[0]
  if (!row) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: opts.ownerAgentId
        ? `Error [NOT_FOUND]: queue_id=${opts.queueId} is not owned by agent_id=${opts.ownerAgentId}.`
        : `Error [NOT_FOUND]: no message_queue row with id=${opts.queueId}.`,
    }
  }

  if (row.status === toStatus) {
    return {
      ok: true,
      queue_id: row.id,
      agent_id: row.agent_id,
      message_id: row.message_id,
      status: toStatus,
      already_transitioned: true,
    }
  }

  if (row.status !== fromStatus) {
    return {
      ok: false,
      code: 'INVALID_STATE',
      observed: row.status,
      message: `Error [INVALID_STATE]: ${opts.mode} requires status='${fromStatus}', got '${row.status}' (queue_id=${opts.queueId}).`,
    }
  }

  if (opts.mode === 'done') {
    const decision = await evaluateDoneTransition(
      async (sql, params) => db.query(sql, params),
      { queueId: opts.queueId, agentId: opts.agentId },
    )
    if (!decision.allowed) {
      return {
        ok: false,
        code: decision.code,
        message: formatDoneTransitionRejection(decision),
        decision,
      }
    }
  }

  const setClauses = opts.mode === 'done'
    ? `status = 'done', done_at = now()`
    : `status = 'in_progress'`
  const updateParams = opts.ownerAgentId
    ? [opts.queueId, opts.ownerAgentId, fromStatus]
    : [opts.queueId, fromStatus]
  const updateOwnerFilter = opts.ownerAgentId ? ' AND agent_id = $2' : ''
  const statusParam = opts.ownerAgentId ? '$3' : '$2'
  const updated = await db.execute(
    `UPDATE message_queue
        SET ${setClauses}
      WHERE id = $1${updateOwnerFilter}
        AND status = ${statusParam}`,
    updateParams,
  )
  if (updated.rowCount !== 1) {
    return {
      ok: false,
      code: 'RACE',
      message: `Error [RACE]: ${opts.mode} lost the status='${fromStatus}' transition for queue_id=${opts.queueId}.`,
    }
  }

  return {
    ok: true,
    queue_id: row.id,
    agent_id: row.agent_id,
    message_id: row.message_id,
    status: toStatus,
  }
}
