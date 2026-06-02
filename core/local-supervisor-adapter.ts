/**
 * #602/#603 local supervisor adapter evidence.
 *
 * This module connects the runtime supervisor contract to local launchd/tmux
 * evidence without executing host lifecycle commands. It is intentionally
 * read-only: install/update/cleanup functions return dry-run plans only.
 */
import {
  buildStateDaemonRestorePlan,
  isEphemeralLaunchAgentPath,
  parseStateDaemonLaunchAgentPlist,
  planStateDaemonRestorePrune,
  protectedPathsFromLaunchAgentPlists,
  renderStateDaemonLaunchAgentPlist,
  validateStateDaemonLaunchAgentConfig,
  type PathProbe,
  type StateDaemonLaunchAgentConfig,
  type StateDaemonPreflightResult,
  type StateDaemonPruneTarget,
  type StateDaemonRestorePlan,
} from './state-daemon/launchagent'
import {
  evaluateRuntimeSupervisorConformance,
  type RuntimeEndpointIdentity,
  type RuntimeObservedState,
  type RuntimePathEvidence,
  type RuntimeSupervisorApprovalEvidence,
  type RuntimeSupervisorCapability,
  type RuntimeSupervisorCapabilityName,
  type RuntimeSupervisorConformanceReport,
  type RuntimeSupervisorDesiredStateEvidence,
  type RuntimeSupervisorIntent,
} from './runtime-supervisor-adapter'

export type LocalLaunchdMutationIntent = 'install_plist' | 'cleanup_checkouts'

export interface LocalLaunchdSupervisorOptions {
  intent?: RuntimeSupervisorIntent
  plistText?: string
  config?: StateDaemonLaunchAgentConfig
  plistPath?: string | null
  restoreRoot?: string | null
  probe?: PathProbe
  expectedAgentId?: string
  capabilities?: RuntimeSupervisorCapability[]
  approval?: RuntimeSupervisorApprovalEvidence | null
}

export interface LocalLaunchdSupervisorReport {
  adapter_kind: 'local_launchd'
  mutation_performed: false
  restart_performed: false
  expected_agent_id: string
  agent_id_source: 'launchagent_env' | 'defaulted_state_daemon_listener'
  launchagent: {
    label: string | null
    plist_path: string | null
    program_arguments: string[]
    working_directory: string | null
    restore_root: string | null
  }
  preflight: StateDaemonPreflightResult
  conformance: RuntimeSupervisorConformanceReport
}

export interface LocalLaunchdInstallDryRunOptions {
  commit: string
  restoreRoot?: string
  launchAgentsDir?: string
  bunPath?: string
  databaseUrl?: string
  agentDenylist?: string
  extraEnv?: Record<string, string>
  probe?: PathProbe
  expectedAgentId?: string
  approval?: RuntimeSupervisorApprovalEvidence | null
  activeLaunchAgentPlists?: string[]
  checkoutDirs?: string[]
  keepCheckouts?: number
}

export interface LocalLaunchdInstallDryRunPlan {
  mode: 'dry_run'
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  mutation_performed: false
  restart_performed: false
  execute_allowed: false
  plan: StateDaemonRestorePlan
  plist_text: string
  preflight: StateDaemonPreflightResult
  supervisor_report: LocalLaunchdSupervisorReport
  atomic_update: {
    staged_plist_path: string
    final_plist_path: string
    method: 'write_temp_then_rename'
    approval_required_before_execute: true
  }
  disabled_host_actions: Array<{
    action: 'write_plist' | 'rename_plist' | 'load_or_start_job'
    reason: string
  }>
  cleanup: LocalLaunchdCleanupDryRunPlan | null
}

export interface LocalLaunchdCleanupDryRunPlan {
  mode: 'dry_run'
  mutation_performed: false
  restart_performed: false
  restore_root: string
  protected_paths: string[]
  targets: StateDaemonPruneTarget[]
}

export interface LocalTmuxSessionEvidence {
  supervisor_kind: 'tmux'
  session_name: string
  observed: 'present' | 'missing' | 'unknown'
  current_path?: string | null
  volatile_path: boolean
  mutation_performed: false
  restart_performed: false
}

function emptyConfig(): StateDaemonLaunchAgentConfig {
  return {
    label: null,
    programArguments: [],
    workingDirectory: null,
    standardOutPath: null,
    standardErrorPath: null,
    environmentVariables: {},
  }
}

function pathFact(probe: PathProbe | undefined, path: string | null | undefined): Pick<RuntimePathEvidence, 'exists' | 'executable'> {
  if (!probe || !path) return {}
  return {
    exists: probe.exists(path),
    executable: probe.isExecutable(path),
  }
}

function pathsForConfig(
  config: StateDaemonLaunchAgentConfig,
  plistPath: string | null | undefined,
  probe: PathProbe | undefined,
): RuntimePathEvidence[] {
  const paths: RuntimePathEvidence[] = []
  const program = config.programArguments[0] ?? null
  const entry = config.programArguments[1] ?? null
  const workingDirectory = config.workingDirectory
  const push = (role: RuntimePathEvidence['role'], path: string | null | undefined) => {
    if (!path) return
    paths.push({
      role,
      path,
      ...pathFact(probe, path),
      volatile: isEphemeralLaunchAgentPath(path),
    })
  }

  push('program', program)
  push('artifact', entry)
  push('working_directory', workingDirectory)
  push('config', plistPath)
  push('log', config.standardOutPath)
  push('log', config.standardErrorPath)
  return paths
}

function defaultCapabilities(overrides: RuntimeSupervisorCapability[] | undefined): RuntimeSupervisorCapability[] {
  const byName = new Map<RuntimeSupervisorCapabilityName, RuntimeSupervisorCapability>()
  for (const capability of [
    { name: 'inspect', supported: true },
    { name: 'readiness', supported: true },
    { name: 'wake', supported: false },
    { name: 'start', supported: false, requires_approval: true },
    { name: 'restart', supported: false, requires_approval: true },
  ] satisfies RuntimeSupervisorCapability[]) {
    byName.set(capability.name, capability)
  }
  for (const capability of overrides ?? []) {
    byName.set(capability.name, capability)
  }
  return [...byName.values()]
}

function endpointIdentity(label: string | null, agentId: string): RuntimeEndpointIdentity {
  return {
    endpoint_kind: 'none',
    endpoint_id: label ?? 'local-launchd-state-daemon',
    agent_id: agentId,
    runtime_instance_id: label ?? 'local-launchd-state-daemon',
  }
}

export function buildLocalLaunchdSupervisorReport(
  options: LocalLaunchdSupervisorOptions = {},
): LocalLaunchdSupervisorReport {
  const config = options.config
    ?? (options.plistText ? parseStateDaemonLaunchAgentPlist(options.plistText) : emptyConfig())
  const expectedAgentId = options.expectedAgentId ?? 'state_daemon'
  const envAgentId = config.environmentVariables.AGENT_ID?.trim()
  const observedAgentId = envAgentId && envAgentId.length > 0 ? envAgentId : expectedAgentId
  const agentIdSource = envAgentId && envAgentId.length > 0 ? 'launchagent_env' : 'defaulted_state_daemon_listener'
  const preflight = validateStateDaemonLaunchAgentConfig(config, {
    probe: options.probe,
    restoreRoot: options.restoreRoot ?? config.environmentVariables.STATE_DAEMON_RESTORE_ROOT ?? null,
  })
  const observedState: RuntimeObservedState = preflight.ok ? 'ready' : 'failed'
  const desired: RuntimeSupervisorDesiredStateEvidence = {
    agent_id: expectedAgentId,
    runtime_kind: 'state_daemon',
    desired_state: 'ready',
    supervisor_kind: 'launchd',
    endpoint_identity: endpointIdentity(config.label, expectedAgentId),
  }
  const observed = {
    supervisor_kind: 'launchd' as const,
    runtime_kind: 'state_daemon' as const,
    observed_state: observedState,
    endpoint_identity: endpointIdentity(config.label, observedAgentId),
    capabilities: defaultCapabilities(options.capabilities),
    paths: pathsForConfig(config, options.plistPath, options.probe),
    health: {
      ok: preflight.ok,
      readiness: preflight.ok ? 'ready' as const : 'not_ready' as const,
      failure_codes: preflight.errors.map((issue) => issue.code),
    },
    recovery_mechanisms: [],
  }

  return {
    adapter_kind: 'local_launchd',
    mutation_performed: false,
    restart_performed: false,
    expected_agent_id: expectedAgentId,
    agent_id_source: agentIdSource,
    launchagent: {
      label: config.label,
      plist_path: options.plistPath ?? null,
      program_arguments: [...config.programArguments],
      working_directory: config.workingDirectory,
      restore_root: options.restoreRoot ?? config.environmentVariables.STATE_DAEMON_RESTORE_ROOT ?? null,
    },
    preflight,
    conformance: evaluateRuntimeSupervisorConformance({
      intent: options.intent ?? 'readiness',
      desired,
      observed,
      approval: options.approval ?? null,
    }),
  }
}

export function buildLocalLaunchdInstallDryRunPlan(
  options: LocalLaunchdInstallDryRunOptions,
): LocalLaunchdInstallDryRunPlan {
  const plan = buildStateDaemonRestorePlan(options)
  const plistText = renderStateDaemonLaunchAgentPlist(plan, {
    AGENT_ID: options.expectedAgentId ?? 'state_daemon',
    ...(options.extraEnv ?? {}),
  })
  const supervisorReport = buildLocalLaunchdSupervisorReport({
    plistText,
    plistPath: plan.plistPath,
    restoreRoot: plan.restoreRoot,
    probe: options.probe,
    expectedAgentId: options.expectedAgentId,
    intent: 'readiness',
    approval: options.approval ?? null,
  })
  const cleanup = options.checkoutDirs
    ? planLocalLaunchdSupervisorCleanup({
      restoreRoot: plan.restoreRoot,
      checkoutDirs: options.checkoutDirs,
      activeLaunchAgentPlists: options.activeLaunchAgentPlists,
      keep: options.keepCheckouts,
    })
    : null

  return {
    mode: 'dry_run',
    ok: supervisorReport.preflight.ok && supervisorReport.conformance.ok,
    go_no_go: supervisorReport.preflight.ok && supervisorReport.conformance.ok ? 'GO' : 'NO_GO',
    mutation_performed: false,
    restart_performed: false,
    execute_allowed: false,
    plan,
    plist_text: plistText,
    preflight: supervisorReport.preflight,
    supervisor_report: supervisorReport,
    atomic_update: {
      staged_plist_path: plan.tempPlistPath,
      final_plist_path: plan.plistPath,
      method: 'write_temp_then_rename',
      approval_required_before_execute: true,
    },
    disabled_host_actions: [
      { action: 'write_plist', reason: 'this slice is dry-run only' },
      { action: 'rename_plist', reason: 'atomic LaunchAgent update requires a separate approved execution slice' },
      { action: 'load_or_start_job', reason: 'host supervisor state mutation is outside this slice' },
    ],
    cleanup,
  }
}

export function planLocalLaunchdSupervisorCleanup(input: {
  restoreRoot: string
  checkoutDirs: string[]
  activeLaunchAgentPlists?: string[]
  keep?: number
}): LocalLaunchdCleanupDryRunPlan {
  return {
    mode: 'dry_run',
    mutation_performed: false,
    restart_performed: false,
    restore_root: input.restoreRoot,
    protected_paths: protectedPathsFromLaunchAgentPlists(input.activeLaunchAgentPlists ?? []),
    targets: planStateDaemonRestorePrune(input),
  }
}

export function observeLocalTmuxSession(input: {
  sessionName: string
  observed?: 'present' | 'missing' | 'unknown'
  currentPath?: string | null
}): LocalTmuxSessionEvidence {
  const currentPath = input.currentPath ?? null
  return {
    supervisor_kind: 'tmux',
    session_name: input.sessionName,
    observed: input.observed ?? 'unknown',
    current_path: currentPath,
    volatile_path: currentPath ? isEphemeralLaunchAgentPath(currentPath) : false,
    mutation_performed: false,
    restart_performed: false,
  }
}

export function formatLocalLaunchdInstallDryRunText(plan: LocalLaunchdInstallDryRunPlan): string {
  const lines = [
    'State-Daemon Local LaunchAgent Install Plan',
    `Result: ${plan.go_no_go}`,
    `Mode: ${plan.mode}`,
    `Mutation Performed: ${plan.mutation_performed}`,
    `Restart Performed: ${plan.restart_performed}`,
    `Execute Allowed: ${plan.execute_allowed}`,
    '',
    'Persistent Paths:',
    `  checkout: ${plan.plan.checkoutPath}`,
    `  entry: ${plan.plan.entryPath}`,
    `  build artifact: ${plan.plan.buildOutfile}`,
    `  logs: ${plan.plan.logsDir}`,
    '',
    'LaunchAgent:',
    `  plist: ${plan.plan.plistPath}`,
    `  temp plist: ${plan.plan.tempPlistPath}`,
    `  atomic update: ${plan.atomic_update.method}`,
    '',
    `Preflight: ${plan.preflight.ok ? 'ok' : 'blocked'}`,
  ]
  for (const issue of plan.preflight.errors) {
    lines.push(`  blocker ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
  }
  for (const issue of plan.preflight.warnings) {
    lines.push(`  warning ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`)
  }
  lines.push('', 'Disabled Host Actions:')
  for (const action of plan.disabled_host_actions) {
    lines.push(`  ${action.action}: ${action.reason}`)
  }
  if (plan.cleanup) {
    lines.push('', 'Cleanup Dry Run:')
    for (const target of plan.cleanup.targets) {
      lines.push(`  ${target.action}: ${target.path} (${target.reason})`)
    }
  }
  return `${lines.join('\n')}\n`
}
