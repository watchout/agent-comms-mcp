import { existsSync, statSync, accessSync, constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  fingerprintFatalStderr,
  inspectStateDaemonRuntime,
  type StateDaemonRuntimeOptions,
  type StateDaemonRuntimeReadiness,
} from './state-daemon-readiness'
import {
  isEphemeralLaunchAgentPath,
  isPathInside,
  parseStateDaemonLaunchAgentPlist,
  STATE_DAEMON_LAUNCH_AGENT_LABEL,
  STATE_DAEMON_PLIST_NAME,
  validateStateDaemonCanaryOverlayEnv,
  validateStateDaemonLaunchAgentConfig,
  type PathProbe,
  type StateDaemonLaunchAgentConfig,
  type StateDaemonPreflightIssue,
} from './state-daemon/launchagent'
import { fullGitShaEquals } from './fleet-checkout-drift'

export type StateDaemonLaunchAgentGoNoGo = 'GO' | 'NO_GO'
export type StateDaemonLaunchAgentFindingSeverity = 'blocker' | 'warning'

export interface StateDaemonLaunchAgentReadinessFinding {
  code: string
  severity: StateDaemonLaunchAgentFindingSeverity
  component: 'plist' | 'path' | 'launchd' | 'identity' | 'process'
  message: string
  path?: string | null
  evidence?: Record<string, unknown>
}

export interface StateDaemonPathEvidence {
  path: string | null
  exists: boolean | null
  is_file: boolean | null
  is_directory: boolean | null
  is_executable: boolean | null
  volatile_tmp: boolean | null
}

export interface StateDaemonLaunchAgentReadinessReport {
  ok: boolean
  go_no_go: StateDaemonLaunchAgentGoNoGo
  generated_at: string
  issue_ref: '#603'
  scope: {
    label: string
    expected_plist_path: string
    require_running: boolean
    allow_private_tmp: boolean
    expected_working_directory: string | null
    expected_checkout_root: string | null
    expected_commit: string | null
    expected_agent_id: string | null
  }
  policy: {
    read_only: true
    dry_run_default: true
    no_db_mutation: true
    no_state_daemon_restart: true
    no_launchctl_bootstrap_or_kickstart: true
    no_discord_activation: true
    no_live_discord_write: true
    no_next_inbox_fifo_drain: true
    no_prompt_driven_processing: true
    no_schema_migration: true
  }
  launchagent: {
    plist_path: string | null
    plist_exists: boolean
    label: string
    config_label: string | null
    program_arguments: string[]
    working_directory: string | null
    standard_out_path: string | null
    standard_error_path: string | null
    environment_variable_keys: string[]
    validation: {
      ok: boolean
      errors: StateDaemonPreflightIssue[]
      warnings: StateDaemonPreflightIssue[]
    } | null
  }
  launchd: StateDaemonRuntimeReadiness['launchd'] & {
    available: boolean
    status: StateDaemonRuntimeReadiness['status']
    checked_at: string
  }
  process: StateDaemonRuntimeReadiness['process']
  paths: {
    program: StateDaemonPathEvidence
    program_arguments_entry: StateDaemonPathEvidence
    working_directory: StateDaemonPathEvidence
    stdout_path: StateDaemonPathEvidence
    stderr_path: StateDaemonPathEvidence
  }
  identity: {
    expected_listener_identity: string
    runtime_kind: 'state_daemon'
    runtime_kind_source: 'launchagent_label'
    agent_id: string | null
    expected_agent_id: string | null
    database_url_present: boolean
    agent_allowlist: string | null
    agent_denylist: string | null
  }
  stderr: StateDaemonRuntimeReadiness['stderr'] & {
    fatal_fingerprint: string | null
  }
  blockers: StateDaemonLaunchAgentReadinessFinding[]
  warnings: StateDaemonLaunchAgentReadinessFinding[]
  recommended_next_commands: string[]
  mutation_performed: false
  restart_performed: false
}

export interface StateDaemonLaunchAgentReadinessOptions {
  label?: string
  plistPath?: string
  now?: () => Date
  requireRunning?: boolean
  allowPrivateTmp?: boolean
  expectedWorkingDirectory?: string | null
  expectedCheckoutRoot?: string | null
  expectedCommit?: string | null
  expectedAgentId?: string | null
  inspectRuntime?: (options?: StateDaemonRuntimeOptions) => StateDaemonRuntimeReadiness
  runtimeOptions?: StateDaemonRuntimeOptions
  readFileSync?: typeof readFileSync
  existsSync?: typeof existsSync
  pathProbe?: PathProbe
}

function defaultPlistPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

function defaultProbe(): PathProbe {
  return {
    exists: (path) => existsSync(path),
    isDirectory: (path) => {
      try { return statSync(path).isDirectory() } catch { return false }
    },
    isFile: (path) => {
      try { return statSync(path).isFile() } catch { return false }
    },
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
  }
}

function pathEvidence(path: string | null, probe: PathProbe): StateDaemonPathEvidence {
  if (!path) {
    return {
      path: null,
      exists: null,
      is_file: null,
      is_directory: null,
      is_executable: null,
      volatile_tmp: null,
    }
  }
  const exists = probe.exists(path)
  return {
    path,
    exists,
    is_file: exists ? probe.isFile(path) : false,
    is_directory: exists ? probe.isDirectory(path) : false,
    is_executable: exists ? probe.isExecutable(path) : false,
    volatile_tmp: isEphemeralLaunchAgentPath(path),
  }
}

function finding(
  code: string,
  severity: StateDaemonLaunchAgentFindingSeverity,
  component: StateDaemonLaunchAgentReadinessFinding['component'],
  message: string,
  extra: Omit<StateDaemonLaunchAgentReadinessFinding, 'code' | 'severity' | 'component' | 'message'> = {},
): StateDaemonLaunchAgentReadinessFinding {
  return { code, severity, component, message, ...extra }
}

function issueToFinding(issue: StateDaemonPreflightIssue): StateDaemonLaunchAgentReadinessFinding {
  const map: Record<string, string> = {
    state_daemon_label_mismatch: 'LISTENER_LABEL_MISMATCH',
    program_arguments_entry_missing: 'PROGRAM_ARGUMENTS_ENTRY_MISSING',
    bun_path_missing: 'BUN_PATH_MISSING',
    bun_path_not_file: 'BUN_PATH_NOT_FILE',
    bun_path_not_executable: 'BUN_PATH_NOT_EXECUTABLE',
    state_daemon_entry_missing: 'STATE_DAEMON_ENTRY_MISSING',
    working_directory_missing: 'WORKING_DIRECTORY_MISSING',
    ephemeral_launchagent_path: 'EPHEMERAL_LAUNCHAGENT_PATH',
  }
  const component: StateDaemonLaunchAgentReadinessFinding['component'] =
    issue.code.includes('label') ? 'identity' : issue.code.includes('path') || issue.code.includes('directory') || issue.code.includes('entry') || issue.code.includes('bun') ? 'path' : 'plist'
  return finding(map[issue.code] ?? issue.code.toUpperCase(), 'blocker', component, issue.message, {
    path: issue.path ?? null,
    evidence: { source_code: issue.code },
  })
}

function warningFromIssue(issue: StateDaemonPreflightIssue): StateDaemonLaunchAgentReadinessFinding {
  return finding(issue.code.toUpperCase(), 'warning', 'path', issue.message, {
    path: issue.path ?? null,
    evidence: { source_code: issue.code },
  })
}

function safeAgentIds(label: string): Set<string> {
  return new Set(['state-daemon', 'state_daemon', label])
}

function normalizeText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value ? value : null
}

function commitMatches(actual: string, expected: string): boolean {
  return fullGitShaEquals(actual, expected)
}

function uniqueFindings(findings: StateDaemonLaunchAgentReadinessFinding[]): StateDaemonLaunchAgentReadinessFinding[] {
  const seen = new Set<string>()
  const out: StateDaemonLaunchAgentReadinessFinding[] = []
  for (const item of findings) {
    const key = `${item.code}:${item.path ?? ''}:${JSON.stringify(item.evidence ?? {})}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function policy(): StateDaemonLaunchAgentReadinessReport['policy'] {
  return {
    read_only: true,
    dry_run_default: true,
    no_db_mutation: true,
    no_state_daemon_restart: true,
    no_launchctl_bootstrap_or_kickstart: true,
    no_discord_activation: true,
    no_live_discord_write: true,
    no_next_inbox_fifo_drain: true,
    no_prompt_driven_processing: true,
    no_schema_migration: true,
  }
}

function nextCommands(plistPath: string, blockers: StateDaemonLaunchAgentReadinessFinding[]): string[] {
  if (blockers.length === 0) return []
  return [
    `Review blocker evidence for ${plistPath}; do not bootstrap or kickstart until the durable path contract is corrected.`,
  ]
}

export function buildStateDaemonLaunchAgentReadinessReport(
  options: StateDaemonLaunchAgentReadinessOptions = {},
): StateDaemonLaunchAgentReadinessReport {
  const label = options.label ?? STATE_DAEMON_LAUNCH_AGENT_LABEL
  const plistPath = options.plistPath ?? defaultPlistPath(label)
  const now = options.now ?? (() => new Date())
  const probe = options.pathProbe ?? defaultProbe()
  const inspectRuntime = options.inspectRuntime ?? inspectStateDaemonRuntime
  const read = options.readFileSync ?? readFileSync
  const exists = options.existsSync ?? existsSync
  const requireRunning = options.requireRunning === true
  const allowPrivateTmp = options.allowPrivateTmp === true
  const expectedWorkingDirectory = options.expectedWorkingDirectory ? resolve(options.expectedWorkingDirectory) : null
  const expectedCheckoutRoot = options.expectedCheckoutRoot ? resolve(options.expectedCheckoutRoot) : null
  const expectedCommit = normalizeText(options.expectedCommit)
  const expectedAgentId = options.expectedAgentId ?? null
  const runtime = inspectRuntime({
    ...(options.runtimeOptions ?? {}),
    label,
    plistPath,
    now,
    readFileSync: options.runtimeOptions?.readFileSync ?? read,
    existsSync: options.runtimeOptions?.existsSync ?? exists,
  })

  const plistExists = exists(plistPath)
  let plistText: string | null = null
  let config: StateDaemonLaunchAgentConfig | null = null
  if (plistExists) {
    try {
      plistText = read(plistPath, 'utf8')
      config = parseStateDaemonLaunchAgentPlist(plistText)
    } catch {}
  }

  const validation = config
    ? validateStateDaemonLaunchAgentConfig(config, {
      probe,
      allowRestoreOwnedTemp: allowPrivateTmp,
      restoreRoot: config.environmentVariables.STATE_DAEMON_RESTORE_ROOT ?? null,
      now,
    })
    : null
  const programPath = config?.programArguments[0] ?? runtime.paths.program
  const entryPath = config?.programArguments[1] ?? runtime.paths.script
  const workingDirectory = config?.workingDirectory ?? runtime.paths.working_directory
  const stdoutPath = config?.standardOutPath ?? runtime.paths.stdout_path
  const stderrPath = config?.standardErrorPath ?? runtime.paths.stderr_path
  const env = config?.environmentVariables ?? {}
  const agentId = env.AGENT_ID ?? null
  const restoreCommit = normalizeText(env.STATE_DAEMON_RESTORE_COMMIT)
  const blockers: StateDaemonLaunchAgentReadinessFinding[] = []
  const warnings: StateDaemonLaunchAgentReadinessFinding[] = []

  if (!plistExists) {
    blockers.push(finding('LAUNCHAGENT_PLIST_MISSING', 'blocker', 'plist', 'expected state-daemon LaunchAgent plist is missing', {
      path: plistPath,
      evidence: { label },
    }))
  }
  if (validation) {
    blockers.push(...validation.errors.map(issueToFinding))
    warnings.push(...validation.warnings.map(warningFromIssue))
  }
  const loadedOverlayEnv = {
    STATE_DAEMON_AGENT_ALLOWLIST: runtime.environment.agent_allowlist ?? '',
    STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF: runtime.environment.canary_overlay_control_ref ?? '',
    STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF: runtime.environment.canary_overlay_owner_decision_ref ?? '',
    STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT: runtime.environment.canary_overlay_expires_at ?? '',
    STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256: runtime.environment.canary_overlay_prior_plist_sha256 ?? '',
    STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND: runtime.environment.canary_overlay_rollback_command ?? '',
    STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION: runtime.environment.canary_overlay_observed_state_destination ?? '',
    STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST: runtime.environment.canary_overlay_subject_digest ?? '',
  }
  const loadedOverlayValidation = validateStateDaemonCanaryOverlayEnv(loadedOverlayEnv, now())
  blockers.push(...loadedOverlayValidation.issues.map(issueToFinding))
  if (runtime.launchd.loaded === true) {
    const plistOverlayEnv = {
      STATE_DAEMON_AGENT_ALLOWLIST: env.STATE_DAEMON_AGENT_ALLOWLIST ?? '',
      STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF: env.STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF ?? '',
      STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF: env.STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF ?? '',
      STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT: env.STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT ?? '',
      STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256: env.STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256 ?? '',
      STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND: env.STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND ?? '',
      STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION: env.STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION ?? '',
      STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST: env.STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST ?? '',
    }
    const mismatchedKeys = Object.keys(plistOverlayEnv).filter((key) =>
      plistOverlayEnv[key as keyof typeof plistOverlayEnv] !== loadedOverlayEnv[key as keyof typeof loadedOverlayEnv],
    )
    if (mismatchedKeys.length > 0) {
      blockers.push(finding(
        'STATE_DAEMON_CANARY_OVERLAY_LOADED_STATE_DRIFT',
        'blocker',
        'launchd',
        'Loaded state-daemon canary overlay does not match the installed LaunchAgent plist.',
        { evidence: { mismatched_keys: mismatchedKeys } },
      ))
    }
  }
  if (!allowPrivateTmp) {
    for (const [field, value] of [
      ['program', programPath],
      ['program_arguments_entry', entryPath],
      ['working_directory', workingDirectory],
      ['process_command', runtime.process.command],
      ['process_cwd', runtime.process.cwd],
    ] as const) {
      if (value && isEphemeralLaunchAgentPath(value)) {
        blockers.push(finding('EPHEMERAL_LAUNCHAGENT_PATH', 'blocker', field.startsWith('process') ? 'process' : 'path', 'state-daemon LaunchAgent/process must not point at /tmp or /private/tmp', {
          path: value,
          evidence: { field },
        }))
      }
    }
  }
  if (expectedWorkingDirectory && workingDirectory && resolve(workingDirectory) !== expectedWorkingDirectory) {
    blockers.push(finding('WORKING_DIRECTORY_MISMATCH', 'blocker', 'path', 'WorkingDirectory does not match the expected durable checkout path', {
      path: workingDirectory,
      evidence: { expected_working_directory: expectedWorkingDirectory },
    }))
  }
  if (expectedCheckoutRoot && workingDirectory && !isPathInside(expectedCheckoutRoot, workingDirectory)) {
    blockers.push(finding('CHECKOUT_ROOT_MISMATCH', 'blocker', 'path', 'WorkingDirectory is outside the expected checkout root', {
      path: workingDirectory,
      evidence: { expected_checkout_root: expectedCheckoutRoot },
    }))
  }
  if (expectedCommit) {
    if (!restoreCommit) {
      blockers.push(finding('RESTORE_COMMIT_MISSING', 'blocker', 'path', 'STATE_DAEMON_RESTORE_COMMIT is missing from LaunchAgent EnvironmentVariables', {
        evidence: { expected_commit: expectedCommit },
      }))
    } else if (!commitMatches(restoreCommit, expectedCommit)) {
      blockers.push(finding('RESTORE_COMMIT_MISMATCH', 'blocker', 'path', 'STATE_DAEMON_RESTORE_COMMIT does not match the approved deployed commit', {
        evidence: { restore_commit: restoreCommit, expected_commit: expectedCommit },
      }))
    }
    if (workingDirectory && !commitMatches(basename(resolve(workingDirectory)), expectedCommit)) {
      blockers.push(finding('WORKING_DIRECTORY_COMMIT_MISMATCH', 'blocker', 'path', 'WorkingDirectory checkout segment does not match the approved deployed commit', {
        path: workingDirectory,
        evidence: { expected_commit: expectedCommit },
      }))
    }
  }
  if (runtime.process.cwd && workingDirectory && resolve(runtime.process.cwd) !== resolve(workingDirectory)) {
    blockers.push(finding('PROCESS_CWD_MISMATCH', 'blocker', 'process', 'running process cwd differs from LaunchAgent WorkingDirectory', {
      path: runtime.process.cwd,
      evidence: { working_directory: workingDirectory },
    }))
  }
  if (expectedAgentId) {
    if (!agentId) {
      blockers.push(finding('AGENT_ID_MISSING', 'blocker', 'identity', 'expected AGENT_ID evidence is missing from LaunchAgent EnvironmentVariables', {
        evidence: { expected_agent_id: expectedAgentId },
      }))
    } else if (agentId !== expectedAgentId) {
      blockers.push(finding('AGENT_ID_MISMATCH', 'blocker', 'identity', 'LaunchAgent AGENT_ID does not match expected state-daemon listener identity', {
        evidence: { agent_id: agentId, expected_agent_id: expectedAgentId },
      }))
    }
  } else if (agentId && !safeAgentIds(label).has(agentId)) {
    blockers.push(finding('AGENT_ID_MISMATCH', 'blocker', 'identity', 'LaunchAgent AGENT_ID looks like a bot identity instead of state-daemon listener identity', {
      evidence: { agent_id: agentId, allowed_agent_ids: Array.from(safeAgentIds(label)) },
    }))
  }
  if (requireRunning) {
    if (runtime.launchd.loaded === false || runtime.status === 'unloaded') {
      blockers.push(finding('STATE_DAEMON_UNLOADED', 'blocker', 'launchd', 'state-daemon LaunchAgent is not loaded', {
        evidence: { launchd: runtime.launchd, status: runtime.status },
      }))
    } else if (runtime.launchd.loaded === true && runtime.launchd.running === false) {
      blockers.push(finding('STATE_DAEMON_NOT_RUNNING', 'blocker', 'launchd', 'state-daemon LaunchAgent is loaded but not running', {
        evidence: { launchd: runtime.launchd, status: runtime.status },
      }))
    }
  }
  const fatalFingerprint = runtime.stderr.fatal_fingerprint ?? (stderrPath && probe.exists(stderrPath)
    ? (() => {
      try { return fingerprintFatalStderr(read(stderrPath, 'utf8')) } catch { return null }
    })()
    : null)
  if (runtime.status === 'degraded' || fatalFingerprint) {
    blockers.push(finding('STATE_DAEMON_CRASH_LOOP_EVIDENCE', 'blocker', 'launchd', 'state-daemon stderr indicates a module/load crash-loop', {
      path: stderrPath,
      evidence: { stderr: { ...runtime.stderr, fatal_fingerprint: fatalFingerprint }, launchd: runtime.launchd },
    }))
  }

  const finalBlockers = uniqueFindings(blockers)
  const ok = finalBlockers.length === 0
  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: now().toISOString(),
    issue_ref: '#603',
    scope: {
      label,
      expected_plist_path: plistPath,
      require_running: requireRunning,
      allow_private_tmp: allowPrivateTmp,
      expected_working_directory: expectedWorkingDirectory,
      expected_checkout_root: expectedCheckoutRoot,
      expected_commit: expectedCommit,
      expected_agent_id: expectedAgentId,
    },
    policy: policy(),
    launchagent: {
      plist_path: plistExists ? plistPath : null,
      plist_exists: plistExists,
      label,
      config_label: config?.label ?? null,
      program_arguments: config?.programArguments ?? [programPath, entryPath].filter((value): value is string => Boolean(value)),
      working_directory: workingDirectory,
      standard_out_path: stdoutPath,
      standard_error_path: stderrPath,
      environment_variable_keys: Object.keys(env).sort(),
      validation: validation ? {
        ok: validation.ok,
        errors: validation.errors,
        warnings: validation.warnings,
      } : null,
    },
    launchd: {
      ...runtime.launchd,
      available: runtime.launchd.available,
      status: runtime.status,
      checked_at: runtime.checked_at,
    },
    process: runtime.process,
    paths: {
      program: pathEvidence(programPath, probe),
      program_arguments_entry: pathEvidence(entryPath, probe),
      working_directory: pathEvidence(workingDirectory, probe),
      stdout_path: pathEvidence(stdoutPath, probe),
      stderr_path: pathEvidence(stderrPath, probe),
    },
    identity: {
      expected_listener_identity: label,
      runtime_kind: 'state_daemon',
      runtime_kind_source: 'launchagent_label',
      agent_id: agentId,
      expected_agent_id: expectedAgentId,
      database_url_present: Boolean(env.DATABASE_URL ?? runtime.environment.database_url),
      agent_allowlist: env.STATE_DAEMON_AGENT_ALLOWLIST ?? runtime.environment.agent_allowlist,
      agent_denylist: env.STATE_DAEMON_AGENT_DENYLIST ?? runtime.environment.agent_denylist,
    },
    stderr: {
      ...runtime.stderr,
      path: stderrPath ?? runtime.stderr.path,
      exists: runtime.stderr.exists ?? (stderrPath ? probe.exists(stderrPath) : null),
      fatal_fingerprint: fatalFingerprint,
    },
    blockers: finalBlockers,
    warnings: uniqueFindings(warnings),
    recommended_next_commands: nextCommands(plistPath, finalBlockers),
    mutation_performed: false,
    restart_performed: false,
  }
}

export function formatStateDaemonLaunchAgentReadinessText(report: StateDaemonLaunchAgentReadinessReport): string {
  const lines = [
    'State-Daemon LaunchAgent Readiness',
    `Result: ${report.go_no_go}`,
    `Label: ${report.scope.label}`,
    `Plist: ${report.launchagent.plist_path ?? report.scope.expected_plist_path} exists=${String(report.launchagent.plist_exists)}`,
    `Program: ${report.paths.program.path ?? '(none)'} executable=${String(report.paths.program.is_executable)}`,
    `Entry: ${report.paths.program_arguments_entry.path ?? '(none)'} exists=${String(report.paths.program_arguments_entry.exists)}`,
    `WorkingDirectory: ${report.paths.working_directory.path ?? '(none)'} exists=${String(report.paths.working_directory.exists)}`,
    `Launchd: available=${String(report.launchd.available)} loaded=${String(report.launchd.loaded)} running=${String(report.launchd.running)} status=${report.launchd.status}`,
    `Process: pid=${report.process.pid ?? '-'} cwd=${report.process.cwd ?? '-'}`,
    `Identity: runtime=${report.identity.runtime_kind} AGENT_ID=${report.identity.agent_id ?? '(none)'}`,
    `Stderr fatal: ${report.stderr.fatal_fingerprint ?? 'none'}`,
    `Mutation performed: ${String(report.mutation_performed)}`,
    `Restart performed: ${String(report.restart_performed)}`,
  ]
  if (report.blockers.length > 0) {
    lines.push('', 'Blockers:')
    for (const blocker of report.blockers) {
      lines.push(`- ${blocker.code}: ${blocker.message}${blocker.path ? ` (${blocker.path})` : ''}`)
    }
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}${warning.path ? ` (${warning.path})` : ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}
