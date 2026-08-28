/**
 * Fleet runtime diagnostics — read-only classifier.
 *
 * Classifies each online bot's runtime health without modifying any state.
 * Detects:
 *   - wake-stuck: pending queue + no active claims + no wake progress
 *   - runtime_mismatch: DB runtime_engine_preference != observed pane command
 *   - codex_runner_gap: codex-runtime bot has stuck pending (needs codex-runner)
 *   - missing_lease: active connector without a valid endpoint lease
 */
export type RuntimePref = 'codex' | 'claude-code' | 'unknown'

export interface BotRuntimeRow {
  agent_id: string
  runtime_pref: RuntimePref
  status: string
  tmux_session: string | null
  stuck_pending: number
  active_claims: number
}

export type DiagnosticKind =
  | 'wake_stuck'
  | 'runtime_mismatch'
  | 'codex_runner_gap'
  | 'missing_lease'

export interface DiagnosticIssue {
  kind: DiagnosticKind
  agent_id: string
  detail: string
}

export interface BotDiagnostic {
  agent_id: string
  runtime_pref: RuntimePref
  status: string
  tmux_session: string | null
  stuck_pending: number
  active_claims: number
  issues: DiagnosticKind[]
}

export interface FleetDiagnosticsResult {
  bots: BotDiagnostic[]
  issues: DiagnosticIssue[]
  summary: {
    total: number
    wake_stuck: number
    runtime_mismatch: number
    codex_runner_gap: number
    missing_lease: number
  }
}

// Maps observed tmux pane command to expected runtime category.
// 'node' covers both claude (electron) and codex (node-based) processes.
const CODEX_PANE_COMMANDS = new Set(['node', 'codex'])
// 'claude.exe' is the macOS pane command for the Claude Code CLI
const CLAUDE_PANE_COMMANDS = new Set(['node', 'claude', 'claude.exe', 'bun'])

export function classifyRuntimePref(raw: string | null | undefined): RuntimePref {
  const v = raw?.trim().toLowerCase()
  if (v === 'codex' || v === 'codex-runner') return 'codex'
  if (v === 'claude-code' || v === 'claude') return 'claude-code'
  return 'unknown'
}

export function detectRuntimeMismatch(
  runtimePref: RuntimePref,
  paneCommand: string | null,
): boolean {
  if (!paneCommand || paneCommand === 'unknown') return false
  if (runtimePref === 'codex') return !CODEX_PANE_COMMANDS.has(paneCommand)
  if (runtimePref === 'claude-code') return !CLAUDE_PANE_COMMANDS.has(paneCommand)
  return false
}

export function classifyBot(
  row: BotRuntimeRow,
  paneCommand: string | null,
): BotDiagnostic {
  const issues: DiagnosticKind[] = []

  if (row.stuck_pending > 0 && row.active_claims === 0) {
    issues.push('wake_stuck')
  }

  if (detectRuntimeMismatch(row.runtime_pref, paneCommand)) {
    issues.push('runtime_mismatch')
  }

  // codex-runtime bots with stuck pending need codex-runner to drain.
  // wake-daemon's tmux send-keys "check inbox" does not reliably wake a
  // Codex TUI session — only the state-daemon codex-runner path does.
  if (row.runtime_pref === 'codex' && row.stuck_pending > 0 && row.active_claims === 0) {
    issues.push('codex_runner_gap')
  }

  return {
    agent_id: row.agent_id,
    runtime_pref: row.runtime_pref,
    status: row.status,
    tmux_session: row.tmux_session,
    stuck_pending: row.stuck_pending,
    active_claims: row.active_claims,
    issues,
  }
}

export function buildFleetDiagnostics(
  rows: BotRuntimeRow[],
  paneCommands: Record<string, string>,
  missingLeaseAgentIds: string[],
): FleetDiagnosticsResult {
  const bots: BotDiagnostic[] = []
  const issues: DiagnosticIssue[] = []

  for (const row of rows) {
    const paneCmd = row.tmux_session ? (paneCommands[row.tmux_session] ?? null) : null
    const diag = classifyBot(row, paneCmd)
    bots.push(diag)

    for (const kind of diag.issues) {
      issues.push({
        kind,
        agent_id: row.agent_id,
        detail: buildIssueDetail(kind, row, paneCmd),
      })
    }
  }

  for (const agentId of missingLeaseAgentIds) {
    issues.push({
      kind: 'missing_lease',
      agent_id: agentId,
      detail: `${agentId}: active connector has no valid endpoint lease`,
    })
    const bot = bots.find((b) => b.agent_id === agentId)
    if (bot && !bot.issues.includes('missing_lease')) {
      bot.issues.push('missing_lease')
    }
  }

  return {
    bots,
    issues,
    summary: {
      total: bots.length,
      wake_stuck: issues.filter((i) => i.kind === 'wake_stuck').length,
      runtime_mismatch: issues.filter((i) => i.kind === 'runtime_mismatch').length,
      codex_runner_gap: issues.filter((i) => i.kind === 'codex_runner_gap').length,
      missing_lease: issues.filter((i) => i.kind === 'missing_lease').length,
    },
  }
}

function buildIssueDetail(
  kind: DiagnosticKind,
  row: BotRuntimeRow,
  paneCmd: string | null,
): string {
  switch (kind) {
    case 'wake_stuck':
      return `${row.agent_id}: ${row.stuck_pending} stuck pending, 0 active claims`
    case 'runtime_mismatch':
      return `${row.agent_id}: DB runtime_pref=${row.runtime_pref} but pane running ${paneCmd ?? 'unknown'}`
    case 'codex_runner_gap':
      return `${row.agent_id}: ${row.stuck_pending} stuck pending — codex-runner required to drain`
    case 'missing_lease':
      return `${row.agent_id}: active connector has no valid endpoint lease`
  }
}
