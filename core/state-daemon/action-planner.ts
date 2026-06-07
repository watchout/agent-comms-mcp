export type QueueActionKind =
  | 'wake_pending'
  | 'wake_received'
  | 'invoke_codex_runner'
  | 'observe_busy'
  | 'reclaim_expired'
  | 'observe_received'
  | 'observe_in_progress'
  | 'terminal_non_actionable'
  | 'routing_hold'
  | 'terminal_noop'
  | 'runtime_skip'
  | 'tmux_missing'
  | 'agent_missing'
  | 'agent_inactive'
  | 'observe_unknown'

export interface PlannerQueueRow {
  status: string
  claim_expires_at: Date | string | null
}

export interface PlannerAgentRow {
  runtime: string | null
  runtime_engine_preference?: string | null
  tmux_session: string | null
  status?: string | null
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

const CODEX_RUNTIMES = new Set(['codex', 'codex-runner', 'CODEX', 'CODEX_RUNNER'])

function isCodexRuntime(runtime: string | null): boolean {
  return runtime !== null && CODEX_RUNTIMES.has(runtime)
}

function isInactiveAgent(status: string | null | undefined): boolean {
  return status === 'disabled' || status === 'offline' || status === 'retired'
}

function effectiveRuntime(agent: PlannerAgentRow): string | null {
  return agent.runtime_engine_preference?.trim() || agent.runtime
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
    if (!agent) return { kind: 'observe_received', terminal: false }
    if (isInactiveAgent(agent.status)) return { kind: 'agent_inactive', terminal: false }
    const runtime = effectiveRuntime(agent)
    if (isCodexRuntime(runtime)) return { kind: 'observe_received', terminal: false }
    if (agent.runtime !== defaultRuntime) return { kind: 'runtime_skip', terminal: false }
    if (!agent.tmux_session) return { kind: 'tmux_missing', terminal: false }
    return { kind: 'wake_received', terminal: false }
  }

  if (row.status === 'in_progress') {
    return { kind: 'observe_in_progress', terminal: false }
  }

  if (row.status === 'pending') {
    if (!agent) return { kind: 'agent_missing', terminal: false }
    if (isInactiveAgent(agent.status)) return { kind: 'agent_inactive', terminal: false }
    const runtime = effectiveRuntime(agent)
    if (isCodexRuntime(runtime)) {
      if (hasActiveClaim) return { kind: 'observe_busy', terminal: false }
      return { kind: 'invoke_codex_runner', terminal: false }
    }
    if (agent.runtime !== defaultRuntime) return { kind: 'runtime_skip', terminal: false }
    if (!agent.tmux_session) return { kind: 'tmux_missing', terminal: false }
    if (hasActiveClaim) return { kind: 'observe_busy', terminal: false }
    return { kind: 'wake_pending', terminal: false }
  }

  return { kind: 'observe_unknown', terminal: false }
}
