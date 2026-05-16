export type QueueActionKind =
  | 'wake_pending'
  | 'observe_busy'
  | 'reclaim_expired'
  | 'observe_received'
  | 'observe_in_progress'
  | 'terminal_noop'
  | 'runtime_skip'
  | 'tmux_missing'
  | 'agent_missing'
  | 'observe_unknown'

export interface PlannerQueueRow {
  status: string
  claim_expires_at: Date | string | null
}

export interface PlannerAgentRow {
  runtime: string | null
  tmux_session: string | null
}

export interface PlanQueueActionInput {
  row: PlannerQueueRow
  agent: PlannerAgentRow | null
  now: Date
  defaultRuntime: string
  hasActiveClaim: boolean
}

export interface PlannedQueueAction {
  kind: QueueActionKind
  terminal: boolean
}

const TERMINAL_STATUSES = new Set([
  'replied',
  'skipped',
  'failed',
  'cancelled',
  'completed',
  'done',
])

export function planQueueAction(input: PlanQueueActionInput): PlannedQueueAction {
  const { row, agent, now, defaultRuntime, hasActiveClaim } = input
  if (TERMINAL_STATUSES.has(row.status)) {
    return { kind: 'terminal_noop', terminal: true }
  }

  if (row.status === 'received') {
    if (row.claim_expires_at && new Date(row.claim_expires_at).getTime() < now.getTime()) {
      return { kind: 'reclaim_expired', terminal: false }
    }
    return { kind: 'observe_received', terminal: false }
  }

  if (row.status === 'in_progress') {
    return { kind: 'observe_in_progress', terminal: false }
  }

  if (row.status === 'pending') {
    if (!agent) return { kind: 'agent_missing', terminal: false }
    if (agent.runtime !== defaultRuntime) return { kind: 'runtime_skip', terminal: false }
    if (!agent.tmux_session) return { kind: 'tmux_missing', terminal: false }
    if (hasActiveClaim) return { kind: 'observe_busy', terminal: false }
    return { kind: 'wake_pending', terminal: false }
  }

  return { kind: 'observe_unknown', terminal: false }
}
