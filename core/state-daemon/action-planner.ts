export type QueueActionKind =
  | 'wake_pending'
  | 'wake_received'
  | 'invoke_codex_runner'
  | 'legacy_tui_disabled'
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
  gates: Array<{
    kind: 'memory_ready'
    required: true
    status: 'pending'
  }>
}

// All runtimes that are dispatched through the LLM runner path (invoke_codex_runner action).
// 'codex*' → bun bin/aun.ts codex-runner (legacy batch runner)
// 'claude-code*' / 'claude*' → host-runtime adapter → claude -p headless
const LLM_RUNNER_RUNTIMES = new Set([
  'codex', 'codex-runner', 'CODEX', 'CODEX_RUNNER',
  'claude-code', 'claude', 'CLAUDE', 'CLAUDE_CODE',
])

function isLlmRunnerRuntime(runtime: string | null): boolean {
  return runtime !== null && LLM_RUNNER_RUNTIMES.has(runtime)
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

const MEMORY_READY_ACTIONS = new Set<QueueActionKind>([
  'invoke_codex_runner',
  'reclaim_expired',
])

function planned(kind: QueueActionKind, terminal: boolean): PlannedQueueAction {
  return {
    kind,
    terminal,
    gates: MEMORY_READY_ACTIONS.has(kind)
      ? [{ kind: 'memory_ready', required: true, status: 'pending' }]
      : [],
  }
}

export function planQueueAction(input: PlanQueueActionInput): PlannedQueueAction {
  const { row, agent, now, defaultRuntime, hasActiveClaim } = input
  if (TERMINAL_STATUSES.has(row.status)) {
    return planned('terminal_noop', true)
  }

  if (row.status === 'received') {
    if (row.claim_expires_at && new Date(row.claim_expires_at).getTime() < now.getTime()) {
      return planned('reclaim_expired', false)
    }
    if (!agent) return planned('observe_received', false)
    if (isInactiveAgent(agent.status)) return planned('agent_inactive', false)
    const runtime = effectiveRuntime(agent)
    if (isLlmRunnerRuntime(runtime)) return planned('observe_received', false)
    if (agent.runtime !== defaultRuntime) return planned('runtime_skip', false)
    return planned('legacy_tui_disabled', false)
  }

  if (row.status === 'in_progress') {
    return planned('observe_in_progress', false)
  }

  if (row.status === 'pending') {
    if (!agent) return planned('agent_missing', false)
    if (isInactiveAgent(agent.status)) return planned('agent_inactive', false)
    const runtime = effectiveRuntime(agent)
    if (isLlmRunnerRuntime(runtime)) {
      if (hasActiveClaim) return planned('observe_busy', false)
      return planned('invoke_codex_runner', false)
    }
    if (agent.runtime !== defaultRuntime) return planned('runtime_skip', false)
    if (hasActiveClaim) return planned('observe_busy', false)
    return planned('legacy_tui_disabled', false)
  }

  return planned('observe_unknown', false)
}
