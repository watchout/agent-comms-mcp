import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbAdapter } from './db'
import { collectGitCheckoutEvidence, type GitCheckoutEvidence } from './git-checkout-evidence'
import { parseLsofTcpListeners, type RuntimeCleanupReport } from './runtime-cleanup'
import {
  evaluateStartupSafety,
  extractStartupIdentity,
  type StartupPortListenerEvidence,
  type StartupSafetyReport,
  type StartupTmuxRuntimeEvidence,
} from './startup-safety'
import { parseProcessList, parseTmuxListPanes, observeTmuxRuntime } from './tmux-runtime-inspector'
import {
  parseStateDaemonLaunchAgentPlist,
  STATE_DAEMON_LAUNCH_AGENT_LABEL,
  type StateDaemonLaunchAgentConfig,
} from './state-daemon/launchagent'

export type CanaryBacklogClassification =
  | 'canary_blocker'
  | 'pre_existing_excluded_backlog'
  | 'requires_manual_close_or_rework'

export interface StateDaemonCanaryPreflightFinding {
  code: string
  severity: 'blocker' | 'warning'
  message: string
  evidence?: Record<string, unknown>
}

export interface StateDaemonCanaryBacklogRow {
  queue_id: string
  message_id: string | null
  agent_id: string
  status: string
  created_at: string | null
  claimed_by: string | null
  claim_expires_at: string | null
  classification: CanaryBacklogClassification
}

export interface StateDaemonCanaryPreflightReport {
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  generated_at: string
  issue_ref: '#742'
  policy: {
    read_only: true
    no_db_mutation: true
    no_state_daemon_restart: true
    no_launchctl_mutation: true
    no_discord_gateway_restart: true
    no_fleet_rollout: true
    no_live_canary_insert: true
    queue_daemon_status_not_used_as_evidence: true
  }
  target: {
    agent_id: string
    found: boolean
    enabled: boolean
    runtime: string | null
    runtime_engine_preference: string | null
    tmux_session: string | null
    port: number | null
    home_directory: string | null
  }
  state_daemon: {
    plist_path: string | null
    plist_found: boolean
    working_directory: string | null
    restore_commit: string | null
    checkout: GitCheckoutEvidence | null
    expected_commit: string | null
    commit_matches_expected: boolean | null
    scheduler_enabled: boolean
    agent_allowlist: string[]
    agent_denylist: string[]
    queue_work_runtime: string | null
    queue_work_finalize: string | null
  }
  startup_safety: StartupSafetyReport | null
  queue: {
    target_active_count: number
    non_target_active_count: number
    rows: StateDaemonCanaryBacklogRow[]
  }
  runtime_cleanup: {
    provided: boolean
    plan_hash: string | null
    cleanup_targets: number | null
    unknown_risk_targets: number | null
    targets: Array<{
      target_id: string
      classification: string
      risk: string
      agent_id: string | null
      pid: number | null
      port: number | null
      tmux_session: string | null
      action_kinds: string[]
    }>
  }
  blockers: StateDaemonCanaryPreflightFinding[]
  warnings: StateDaemonCanaryPreflightFinding[]
  recommended_next_commands: string[]
  mutation_performed: false
  restart_performed: false
}

interface AgentProfileRow {
  agent_id: string
  runtime: string | null
  status: string | null
  metadata: unknown
  channel_port: number | string | null
  home_directory: string | null
  runtime_engine_preference: string | null
  profile_enabled: unknown
  disabled_at: string | null
}

interface QueueRow {
  id: string | number
  agent_id: string
  message_id: string | null
  status: string
  created_at: string | Date | null
  claimed_by: string | null
  claim_expires_at: string | Date | null
}

export interface StateDaemonCanaryPreflightOptions {
  targetAgentId: string
  expectedCommit?: string | null
  expectedAllowlist?: string[] | null
  expectedDenylist?: string[] | null
  requireSchedulerEnabled?: boolean
  requireExactAllowlist?: boolean
  staleMinutes?: number
  now?: Date
  plistPath?: string | null
  plistText?: string | null
  checkoutEvidence?: GitCheckoutEvidence | null
  startupPortListeners?: StartupPortListenerEvidence[]
  startupTmuxRuntimeEvidence?: StartupTmuxRuntimeEvidence[]
  runtimeCleanupReport?: RuntimeCleanupReport | null
  env?: NodeJS.ProcessEnv
}

function policy(): StateDaemonCanaryPreflightReport['policy'] {
  return {
    read_only: true,
    no_db_mutation: true,
    no_state_daemon_restart: true,
    no_launchctl_mutation: true,
    no_discord_gateway_restart: true,
    no_fleet_rollout: true,
    no_live_canary_insert: true,
    queue_daemon_status_not_used_as_evidence: true,
  }
}

function cleanText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value ? value : null
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function boolish(raw: unknown): boolean {
  if (raw === true || raw === 1) return true
  if (typeof raw !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

function numberOrNull(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function csv(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean)
}

function iso(raw: string | Date | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  if (raw instanceof Date) return raw.toISOString()
  const parsed = new Date(raw)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(raw)
}

function sameSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false
  const a = [...actual].sort()
  const e = [...expected].sort()
  return a.every((value, index) => value === e[index])
}

function fullShaMatches(actual: string | null | undefined, expected: string | null | undefined): boolean | null {
  const a = cleanText(actual)
  const e = cleanText(expected)
  if (!e) return null
  return Boolean(a && /^[0-9a-f]{40}$/i.test(a) && /^[0-9a-f]{40}$/i.test(e) && a.toLowerCase() === e.toLowerCase())
}

function finding(
  severity: 'blocker' | 'warning',
  code: string,
  message: string,
  evidence?: Record<string, unknown>,
): StateDaemonCanaryPreflightFinding {
  return evidence ? { severity, code, message, evidence } : { severity, code, message }
}

function defaultPlistPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), 'Library', 'LaunchAgents', `${STATE_DAEMON_LAUNCH_AGENT_LABEL}.plist`)
}

function readPlistConfig(options: StateDaemonCanaryPreflightOptions): {
  path: string | null
  found: boolean
  config: StateDaemonLaunchAgentConfig | null
} {
  const env = options.env ?? process.env
  const path = cleanText(options.plistPath) ?? defaultPlistPath(env)
  const text = options.plistText ?? (existsSync(path) ? readFileSync(path, 'utf8') : null)
  if (!text) return { path, found: false, config: null }
  return { path, found: true, config: parseStateDaemonLaunchAgentPlist(text) }
}

function targetEnabled(row: AgentProfileRow | null): boolean {
  if (!row) return false
  if (row.disabled_at) return false
  if (String(row.status ?? '').toLowerCase() === 'disabled') return false
  return row.profile_enabled !== false && row.profile_enabled !== 0 && row.profile_enabled !== '0'
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildStartupCommand(profile: AgentProfileRow | null, session: string | null, port: number | null, env: NodeJS.ProcessEnv): string {
  if (!profile) return ''
  const engine = cleanText(profile.runtime_engine_preference ?? profile.runtime)?.toLowerCase()
  if (engine === 'codex') {
    const databaseUrl = env.AGENT_COMMS_DATABASE_URL ?? env.DATABASE_URL ?? 'postgresql:///agent_comms?host=/tmp'
    const bunCommand = env.AGENT_COMMS_BUN_COMMAND ?? '/Users/yuji/.bun/bin/bun'
    const serverPath = env.AGENT_COMMS_SERVER_PATH ?? join(process.cwd(), 'server.ts')
    const stateDir = join(env.HOME ?? homedir(), '.claude', 'channels', session ?? profile.agent_id)
    const configArgs = [
      'mcp_servers.aun.enabled=true',
      `mcp_servers.aun.command="${bunCommand}"`,
      `mcp_servers.aun.args=["run","${serverPath}"]`,
      `mcp_servers.aun.env.AGENT_ID="${profile.agent_id}"`,
      `mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID="${profile.agent_id}"`,
      `mcp_servers.aun.env.DATABASE_URL="${databaseUrl}"`,
      'mcp_servers.aun.env.AGENT_COM_RUNTIME_HEARTBEAT_DISABLED="0"',
      `mcp_servers.aun.env.WEBHOOK_PORT="${port ?? ''}"`,
      `mcp_servers.aun.env.DISCORD_STATE_DIR="${stateDir}"`,
    ]
    return [
      'codex --dangerously-bypass-approvals-and-sandbox',
      ...configArgs.map((arg) => `-c ${shellSingleQuote(arg)}`),
    ].join(' ')
  }
  if (engine === 'claude' || engine === 'claude-code') {
    return 'claude --mcp-config .mcp.json --dangerously-skip-permissions'
  }
  return ''
}

async function loadTargetProfile(db: DbAdapter, agentId: string): Promise<AgentProfileRow | null> {
  const rows = await db.query<AgentProfileRow>(
    `SELECT agent_id, runtime, status, metadata, channel_port, home_directory,
            runtime_engine_preference, profile_enabled, disabled_at
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  )
  return rows[0] ?? null
}

async function loadActiveQueueRows(db: DbAdapter): Promise<QueueRow[]> {
  return await db.query<QueueRow>(
    `SELECT id, agent_id, message_id, status, created_at, claimed_by, claim_expires_at
       FROM message_queue
      WHERE status IN ('pending','received','in_progress')
      ORDER BY created_at ASC, id ASC`,
  )
}

function classifyQueueRow(row: QueueRow, targetAgentId: string, now: Date, staleMinutes: number): CanaryBacklogClassification {
  if (row.agent_id === targetAgentId) return 'canary_blocker'
  const createdAt = iso(row.created_at)
  const ageMs = createdAt ? now.getTime() - Date.parse(createdAt) : 0
  const stale = Number.isFinite(ageMs) && ageMs > staleMinutes * 60_000
  if ((row.status === 'received' || row.status === 'in_progress') && stale) return 'requires_manual_close_or_rework'
  return 'pre_existing_excluded_backlog'
}

function formatQueueRow(row: QueueRow, targetAgentId: string, now: Date, staleMinutes: number): StateDaemonCanaryBacklogRow {
  return {
    queue_id: String(row.id),
    message_id: row.message_id ?? null,
    agent_id: row.agent_id,
    status: row.status,
    created_at: iso(row.created_at),
    claimed_by: row.claimed_by ?? null,
    claim_expires_at: iso(row.claim_expires_at),
    classification: classifyQueueRow(row, targetAgentId, now, staleMinutes),
  }
}

function runtimeCleanupSummary(report: RuntimeCleanupReport | null | undefined): StateDaemonCanaryPreflightReport['runtime_cleanup'] {
  if (!report) {
    return {
      provided: false,
      plan_hash: null,
      cleanup_targets: null,
      unknown_risk_targets: null,
      targets: [],
    }
  }
  const targets = report.targets
    .filter((target) => target.classification !== 'active' || target.actions.some((action) => action.kind !== 'noop'))
    .map((target) => ({
      target_id: target.target_id,
      classification: target.classification,
      risk: target.risk,
      agent_id: target.agent_id,
      pid: target.pid,
      port: target.port,
      tmux_session: target.tmux_session,
      action_kinds: target.actions.map((action) => action.kind),
    }))
  return {
    provided: true,
    plan_hash: report.plan_hash,
    cleanup_targets: report.summary.cleanup_targets,
    unknown_risk_targets: report.summary.unknown_risk_targets,
    targets,
  }
}

export function collectStartupPortListeners(port: number | null): StartupPortListenerEvidence[] {
  if (!port) return []
  let pidOutput = ''
  try {
    pidOutput = execFileSync('lsof', ['-nP', '-tiTCP:' + String(port), '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }
  return pidOutput
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => {
      let command = ''
      let ppid: number | null = null
      try {
        command = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
        const ppidRaw = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
        const parsedPpid = Number.parseInt(ppidRaw, 10)
        ppid = Number.isInteger(parsedPpid) ? parsedPpid : null
      } catch {}
      const observed = extractStartupIdentity(command).agentId
      return { pid, port, ppid, command, observed_agent_id: observed, orphan: ppid === 1 }
    })
}

export function collectStartupTmuxRuntimeEvidence(sessionName: string | null): StartupTmuxRuntimeEvidence[] {
  if (!sessionName) return []
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' })
  } catch {
    return []
  }
  try {
    const paneOutput = execFileSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_path}'], {
      encoding: 'utf8',
    })
    const processOutput = execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' })
    const processes = parseProcessList(processOutput)
    return parseTmuxListPanes(paneOutput).flatMap((pane) => observeTmuxRuntime(pane, processes)).map((obs) => ({
      session_name: obs.session_name,
      observed_agent_id: obs.observed_agent_id,
      expected_agent_id: obs.expected_agent_id,
      server_pid: obs.server_pid,
    }))
  } catch {
    return []
  }
}

export function collectRuntimeCleanupPortListeners(): ReturnType<typeof parseLsofTcpListeners> {
  try {
    const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    return parseLsofTcpListeners(output)
  } catch {
    return []
  }
}

export async function buildStateDaemonCanaryPreflightReport(
  db: DbAdapter,
  options: StateDaemonCanaryPreflightOptions,
): Promise<StateDaemonCanaryPreflightReport> {
  const now = options.now ?? new Date()
  const staleMinutes = options.staleMinutes ?? 60
  const targetAgentId = options.targetAgentId
  const expectedAllowlist = options.expectedAllowlist ?? [targetAgentId]
  const requireExactAllowlist = options.requireExactAllowlist ?? true
  const env = options.env ?? process.env
  const profile = await loadTargetProfile(db, targetAgentId)
  const metadata = parseJsonObject(profile?.metadata)
  const tmuxSession = cleanText(metadata.tmux_session)
  const port = numberOrNull(profile?.channel_port)
  const startupCommand = buildStartupCommand(profile, tmuxSession, port, env)
  const startupSafety = profile
    ? evaluateStartupSafety({
      agentId: profile.agent_id,
      expectedAgentId: profile.agent_id,
      sessionName: tmuxSession,
      port,
      command: startupCommand,
      launcherRoot: cleanText(profile.home_directory) ?? process.cwd(),
      portListeners: options.startupPortListeners ?? collectStartupPortListeners(port),
      tmuxRuntimeEvidence: options.startupTmuxRuntimeEvidence ?? collectStartupTmuxRuntimeEvidence(tmuxSession),
      codexPostStartEnterPolicy: 'update_prompt_only',
    })
    : null
  const plist = readPlistConfig(options)
  const envVars = plist.config?.environmentVariables ?? {}
  const schedulerEnabled = boolish(envVars.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED)
  const agentAllowlist = csv(envVars.STATE_DAEMON_AGENT_ALLOWLIST)
  const agentDenylist = csv(envVars.STATE_DAEMON_AGENT_DENYLIST)
  const workingDirectory = plist.config?.workingDirectory ?? null
  const checkout = options.checkoutEvidence
    ?? (workingDirectory ? collectGitCheckoutEvidence(workingDirectory) : null)
  const expectedCommit = cleanText(options.expectedCommit)
  const commitMatchesExpected = fullShaMatches(checkout?.commit_sha, expectedCommit)
  const queueRows = (await loadActiveQueueRows(db)).map((row) => formatQueueRow(row, targetAgentId, now, staleMinutes))
  const runtimeCleanup = runtimeCleanupSummary(options.runtimeCleanupReport)
  const blockers: StateDaemonCanaryPreflightFinding[] = []
  const warnings: StateDaemonCanaryPreflightFinding[] = []

  if (!profile) {
    blockers.push(finding('blocker', 'canary_target_missing', `target agent ${targetAgentId} does not exist`))
  } else if (!targetEnabled(profile)) {
    blockers.push(finding('blocker', 'canary_target_not_enabled', `target agent ${targetAgentId} is not enabled`, {
      status: profile.status,
      profile_enabled: profile.profile_enabled,
      disabled_at: profile.disabled_at,
    }))
  }
  if (!plist.found) {
    blockers.push(finding('blocker', 'state_daemon_plist_missing', 'state-daemon LaunchAgent plist was not found', {
      plist_path: plist.path,
    }))
  }
  if (options.requireSchedulerEnabled && !schedulerEnabled) {
    blockers.push(finding('blocker', 'scheduler_not_enabled', 'STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED is not enabled'))
  }
  if (requireExactAllowlist && !sameSet(agentAllowlist, expectedAllowlist)) {
    blockers.push(finding('blocker', 'scheduler_allowlist_not_exact_target', 'state-daemon allowlist is not exactly the canary target', {
      actual: agentAllowlist,
      expected: expectedAllowlist,
    }))
  }
  if (options.expectedDenylist && !sameSet(agentDenylist, options.expectedDenylist)) {
    blockers.push(finding('blocker', 'scheduler_denylist_changed', 'state-daemon denylist differs from the expected preserved value', {
      actual: agentDenylist,
      expected: options.expectedDenylist,
    }))
  } else if (agentDenylist.length === 0) {
    warnings.push(finding('warning', 'scheduler_denylist_missing', 'STATE_DAEMON_AGENT_DENYLIST is empty or absent'))
  }
  if (expectedCommit && commitMatchesExpected !== true) {
    blockers.push(finding('blocker', 'state_daemon_commit_mismatch', 'state-daemon checkout does not match expected commit', {
      actual: checkout?.commit_sha ?? null,
      expected: expectedCommit,
    }))
  }
  if (checkout?.dirty) {
    blockers.push(finding('blocker', 'state_daemon_checkout_dirty', 'state-daemon checkout has local modifications', {
      status_short: checkout.status_short,
    }))
  }
  for (const blocker of startupSafety?.blockers ?? []) {
    blockers.push(finding('blocker', `startup_safety_${blocker.code}`, blocker.detail))
  }
  for (const warning of startupSafety?.warnings ?? []) {
    warnings.push(finding('warning', `startup_safety_${warning.code}`, warning.detail))
  }

  const targetRows = queueRows.filter((row) => row.agent_id === targetAgentId)
  if (targetRows.length > 0) {
    blockers.push(finding('blocker', 'canary_target_has_active_queue_rows', 'canary target has pre-existing active queue rows', {
      queue_ids: targetRows.map((row) => row.queue_id),
    }))
  }
  const manualRows = queueRows.filter((row) => row.classification === 'requires_manual_close_or_rework')
  if (manualRows.length > 0) {
    warnings.push(finding('warning', 'pre_existing_backlog_requires_manual_close_or_rework', 'non-target active backlog needs manual close or rework classification', {
      rows: manualRows.map((row) => ({ queue_id: row.queue_id, agent_id: row.agent_id, status: row.status })),
    }))
  }
  const excludedRows = queueRows.filter((row) => row.classification === 'pre_existing_excluded_backlog')
  if (excludedRows.length > 0) {
    warnings.push(finding('warning', 'pre_existing_excluded_backlog_present', 'non-target active backlog exists and must remain excluded from the canary', {
      count: excludedRows.length,
    }))
  }
  if (runtimeCleanup.unknown_risk_targets && runtimeCleanup.unknown_risk_targets > 0) {
    blockers.push(finding('blocker', 'runtime_cleanup_unknown_risk_targets', 'runtime cleanup dry-run found unknown-risk targets', {
      targets: runtimeCleanup.targets.filter((target) => target.risk === 'unknown-risk').map((target) => target.target_id),
    }))
  }
  if (runtimeCleanup.cleanup_targets && runtimeCleanup.cleanup_targets > 0) {
    warnings.push(finding('warning', 'runtime_cleanup_targets_present', 'runtime cleanup dry-run found stale/residue targets to review before canary', {
      targets: runtimeCleanup.targets.map((target) => target.target_id),
    }))
  }

  const ok = blockers.length === 0
  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: now.toISOString(),
    issue_ref: '#742',
    policy: policy(),
    target: {
      agent_id: targetAgentId,
      found: Boolean(profile),
      enabled: targetEnabled(profile),
      runtime: profile?.runtime ?? null,
      runtime_engine_preference: profile?.runtime_engine_preference ?? null,
      tmux_session: tmuxSession,
      port,
      home_directory: profile?.home_directory ?? null,
    },
    state_daemon: {
      plist_path: plist.path,
      plist_found: plist.found,
      working_directory: workingDirectory,
      restore_commit: envVars.STATE_DAEMON_RESTORE_COMMIT ?? null,
      checkout,
      expected_commit: expectedCommit,
      commit_matches_expected: commitMatchesExpected,
      scheduler_enabled: schedulerEnabled,
      agent_allowlist: agentAllowlist,
      agent_denylist: agentDenylist,
      queue_work_runtime: envVars.STATE_DAEMON_QUEUE_WORK_RUNTIME ?? null,
      queue_work_finalize: envVars.STATE_DAEMON_QUEUE_WORK_FINALIZE ?? null,
    },
    startup_safety: startupSafety,
    queue: {
      target_active_count: targetRows.length,
      non_target_active_count: queueRows.length - targetRows.length,
      rows: queueRows,
    },
    runtime_cleanup: runtimeCleanup,
    blockers,
    warnings,
    recommended_next_commands: [
      `agent-com state-daemon canary-preflight --agent-id ${targetAgentId} --require-scheduler-enabled --expected-commit <sha> --format json`,
      `AGENT_COMMS_RESTART_DRY_RUN=1 scripts/restart-bot.sh ${targetAgentId}`,
      `agent-com runtime cleanup --dry-run --format json`,
    ],
    mutation_performed: false,
    restart_performed: false,
  }
}

export function formatStateDaemonCanaryPreflightText(report: StateDaemonCanaryPreflightReport): string {
  const lines = [
    `State-daemon canary preflight: ${report.go_no_go}`,
    `Target: ${report.target.agent_id} found=${report.target.found} enabled=${report.target.enabled}`,
    `Scheduler: enabled=${report.state_daemon.scheduler_enabled} allowlist=${report.state_daemon.agent_allowlist.join(',') || '(empty)'}`,
    `Checkout: ${report.state_daemon.checkout?.commit_sha ?? 'unknown'} expected=${report.state_daemon.expected_commit ?? 'none'}`,
    `Queue: target_active=${report.queue.target_active_count} non_target_active=${report.queue.non_target_active_count}`,
    `Startup safety: ${report.startup_safety ? (report.startup_safety.ok ? 'PASS' : 'FAIL') : 'not_run'}`,
  ]
  if (report.blockers.length > 0) {
    lines.push('Blockers:')
    for (const blocker of report.blockers) lines.push(`  - ${blocker.code}: ${blocker.message}`)
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of report.warnings) lines.push(`  - ${warning.code}: ${warning.message}`)
  }
  return `${lines.join('\n')}\n`
}
