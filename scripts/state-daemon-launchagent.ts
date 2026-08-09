#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Client } from 'pg'
import {
  STATE_DAEMON_LAUNCH_AGENT_LABEL,
  buildGithubWorkPullerLaunchAgentEnv,
  buildStateDaemonRestorePlan,
  listStateDaemonRestoreCheckouts,
  parseStateDaemonLaunchAgentPlist,
  planStateDaemonRestorePrune,
  queueWorkSchedulerLaunchAgentEnabled,
  renderStateDaemonLaunchAgentPlist,
  validateShirubeD1LaunchAgentEnv,
  validateAllAgentCommunicationManifestLaunchAgentEnv,
  validateStateDaemonCanaryOverlayEnv,
  validateStateDaemonLaunchAgentConfig,
  validateQueueWorkCanaryResiduePreflight,
  loadQueueWorkResiduePolicyFromEnv,
  type StateDaemonLaunchAgentConfig,
} from '../core/state-daemon/launchagent'

type ParsedArgs = {
  command: 'restore' | 'preflight' | 'prune' | 'help'
  execute: boolean
  noBootstrap: boolean
  extraEnv: Record<string, string>
  commit?: string
  restoreRoot?: string
  launchAgentsDir?: string
  plist?: string
  bunPath?: string
  databaseUrl?: string
  sqlitePath?: string
  keep?: number
  githubWorkPullerEnabled: boolean
  githubWorkRepos?: string
  githubWorkLabels?: string
  githubWorkOwnerAllowlist?: string
  githubWorkIntervalMs?: number
  githubWorkWritebackEnabled: boolean
  bootstrapSafeDefaults: boolean
  githubTokenFile?: string
}

const SHIRUBE_D1_RESTORE_ENV_KEYS = new Set([
  'SHIRUBE_D1_ENABLED',
  'SHIRUBE_D1_KILL_SWITCH',
  'SHIRUBE_D1_ACTIVATION_MODE',
  'SHIRUBE_D1_TARGET_ALLOWLIST',
  'SHIRUBE_D1_AUTHORIZATION_DIGEST',
  'SHIRUBE_D1_ADAPTER_HEAD_SHA',
  'SHIRUBE_D1_AUDIT_REF',
  'SHIRUBE_D1_QA_REF',
  'SHIRUBE_D1_CHECK_REF',
  'SHIRUBE_D1_CTO_GO_REF',
  'SHIRUBE_D1_FLEET_ACTIVATION_REF',
])

const ALL_AGENT_MANIFEST_RESTORE_ENV_KEYS = new Set([
  'STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_ID',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_PATH',
])

const CANARY_OVERLAY_RESTORE_ENV_KEYS = new Set([
  'STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF',
  'STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF',
  'STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT',
  'STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256',
  'STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND',
  'STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION',
  'STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST',
])

const CHECKOUT_BOUND_RESTORE_PATH_ENV_KEYS = [
  'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND',
  'STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE',
] as const

function bindRestorePathsToCheckout(
  extraEnv: Record<string, string>,
  checkoutPath: string,
): Record<string, string> {
  const bound = { ...extraEnv }
  for (const key of CHECKOUT_BOUND_RESTORE_PATH_ENV_KEYS) {
    const value = bound[key]?.trim()
    if (value) bound[key] = resolve(checkoutPath, value)
  }
  return bound
}

function parseCanaryOverlayRestoreEnv(raw: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('--canary-overlay-env-json requires a valid JSON object') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--canary-overlay-env-json requires a JSON object')
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!CANARY_OVERLAY_RESTORE_ENV_KEYS.has(key)) {
      throw new Error(`--canary-overlay-env-json does not allow key: ${key}`)
    }
    if (typeof value !== 'string') throw new Error(`--canary-overlay-env-json requires a string value for ${key}`)
    result[key] = value
  }
  return result
}

function parseAllAgentManifestRestoreEnv(raw: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('--all-agent-manifest-env-json requires a valid JSON object') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--all-agent-manifest-env-json requires a JSON object')
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!ALL_AGENT_MANIFEST_RESTORE_ENV_KEYS.has(key)) {
      throw new Error(`--all-agent-manifest-env-json does not allow key: ${key}`)
    }
    if (typeof value !== 'string') throw new Error(`--all-agent-manifest-env-json requires a string value for ${key}`)
    result[key] = value
  }
  const issues = validateAllAgentCommunicationManifestLaunchAgentEnv(result)
  if (issues.length > 0) {
    throw new Error(`--all-agent-manifest-env-json failed preflight: ${issues.map(issue => issue.code).join(',')}`)
  }
  return result
}

function parseShirubeD1RestoreEnv(raw: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('--shirube-d1-env-json requires a valid JSON object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--shirube-d1-env-json requires a JSON object')
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!SHIRUBE_D1_RESTORE_ENV_KEYS.has(key)) {
      throw new Error(`--shirube-d1-env-json does not allow key: ${key}`)
    }
    if (typeof value !== 'string') {
      throw new Error(`--shirube-d1-env-json requires a string value for ${key}`)
    }
    result[key] = value
  }
  const issues = validateShirubeD1LaunchAgentEnv(result)
  if (issues.length > 0) {
    throw new Error(`--shirube-d1-env-json failed D1 preflight: ${issues.map((issue) => issue.code).join(',')}`)
  }
  return result
}

function usage(): string {
  return `state-daemon LaunchAgent restore helper

Usage:
  bun scripts/state-daemon-launchagent.ts restore --commit <sha> [--execute] [--no-bootstrap]
    [--bootstrap-safe-defaults]
    [--configuration-reconciler-enabled]
    [--database-url <postgres-url> | --sqlite-path <sqlite-file>]
    [--github-work-puller-enabled --github-work-repos <owner/repo>
     --github-work-labels <canary:label>
     --github-work-owner-allowlist <agent>
     --github-token-file <path>]
  bun scripts/state-daemon-launchagent.ts restore --commit <sha>
    --enable-queue-work-scheduler --agent-allowlist <agent>
    --canary-overlay-env-json <bounded-json>
    --queue-work-runtime codex-exec --queue-work-fence-message-ids <id>
    [--queue-work-fence-created-after <iso>]
    [--defer-newer-pending]
    [--queue-work-github-writeback-mode mediated]
    [--queue-work-mediated-posting-command <path>]
    [--github-token-file <path>]
    [--queue-work-residue-policy-file <path>] [--execute]
  bun scripts/state-daemon-launchagent.ts restore --commit <sha>
    --disable-codex-runner [--execute]
  bun scripts/state-daemon-launchagent.ts restore --commit <sha>
    --shirube-d1-env-json <bounded-json> [--execute]
  bun scripts/state-daemon-launchagent.ts restore --commit <sha>
    --all-agent-manifest-env-json <bounded-json> [--execute]
  bun scripts/state-daemon-launchagent.ts preflight [--plist <path>]
  bun scripts/state-daemon-launchagent.ts prune [--restore-root <path>] [--keep N] [--execute]

Defaults are dry-run. The restore command creates/verifies a durable checkout
under ~/.agent-comms/state-daemon/checkouts/<sha>, verifies dependencies/build,
stages a plist, validates ProgramArguments[1] and WorkingDirectory, then
atomically replaces the LaunchAgent plist only when --execute is present.
`
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = (argv[0] ?? 'help') as ParsedArgs['command']
  if (!['restore', 'preflight', 'prune', 'help'].includes(command)) {
    throw new Error(`unknown command: ${command}`)
  }
  const args: ParsedArgs = {
    command,
    execute: false,
    noBootstrap: false,
    extraEnv: {},
    githubWorkPullerEnabled: false,
    githubWorkWritebackEnabled: false,
    bootstrapSafeDefaults: false,
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--execute') args.execute = true
    else if (arg === '--dry-run') args.execute = false
    else if (arg === '--no-bootstrap') args.noBootstrap = true
    else if (arg === '--commit') args.commit = next()
    else if (arg === '--restore-root') args.restoreRoot = next()
    else if (arg === '--launchagents-dir') args.launchAgentsDir = next()
    else if (arg === '--plist') args.plist = next()
    else if (arg === '--bun') args.bunPath = next()
    else if (arg === '--database-url') args.databaseUrl = next()
    else if (arg === '--sqlite-path') args.sqlitePath = resolve(next())
    else if (arg === '--shirube-d1-env-json') Object.assign(args.extraEnv, parseShirubeD1RestoreEnv(next()))
    else if (arg === '--all-agent-manifest-env-json') Object.assign(args.extraEnv, parseAllAgentManifestRestoreEnv(next()))
    else if (arg === '--canary-overlay-env-json') Object.assign(args.extraEnv, parseCanaryOverlayRestoreEnv(next()))
    else if (arg === '--github-work-puller-enabled') args.githubWorkPullerEnabled = true
    else if (arg === '--github-work-repos') args.githubWorkRepos = next()
    else if (arg === '--github-work-labels') args.githubWorkLabels = next()
    else if (arg === '--github-work-owner-allowlist') args.githubWorkOwnerAllowlist = next()
    else if (arg === '--github-work-interval-ms') {
      const value = next()
      if (!/^\d+$/.test(value) || Number.parseInt(value, 10) <= 0) {
        throw new Error('--github-work-interval-ms requires a positive integer')
      }
      args.githubWorkIntervalMs = Number.parseInt(value, 10)
    }
    else if (arg === '--github-work-writeback-enabled') args.githubWorkWritebackEnabled = true
    else if (arg === '--github-token-file') args.githubTokenFile = next()
    else if (arg === '--agent-allowlist') args.extraEnv.STATE_DAEMON_AGENT_ALLOWLIST = next()
    else if (arg === '--disable-codex-runner') args.extraEnv.STATE_DAEMON_CODEX_RUNNER_ENABLED = '0'
    else if (arg === '--bootstrap-safe-defaults') {
      args.bootstrapSafeDefaults = true
      args.extraEnv.SHIRUBE_D1_ENABLED = '0'
      args.extraEnv.SHIRUBE_D1_KILL_SWITCH = '1'
      args.extraEnv.SHIRUBE_D1_TARGET_ALLOWLIST = '[]'
      args.extraEnv.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED = '0'
      args.extraEnv.STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED = '0'
    }
    else if (arg === '--configuration-reconciler-enabled') args.extraEnv.STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED = '1'
    else if (arg === '--enable-queue-work-scheduler') args.extraEnv.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED = '1'
    else if (arg === '--queue-work-runtime') args.extraEnv.STATE_DAEMON_QUEUE_WORK_RUNTIME = next()
    else if (arg === '--queue-work-command') args.extraEnv.STATE_DAEMON_QUEUE_WORK_COMMAND = next()
    else if (arg === '--queue-work-args-json') args.extraEnv.STATE_DAEMON_QUEUE_WORK_ARGS_JSON = next()
    else if (arg === '--queue-work-timeout-ms') args.extraEnv.STATE_DAEMON_QUEUE_WORK_TIMEOUT_MS = next()
    else if (arg === '--queue-work-finalize') args.extraEnv.STATE_DAEMON_QUEUE_WORK_FINALIZE = '1'
    else if (arg === '--queue-work-codex-executable') args.extraEnv.STATE_DAEMON_QUEUE_WORK_CODEX_EXECUTABLE = next()
    else if (arg === '--queue-work-codex-output-schema') args.extraEnv.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA = next()
    else if (arg === '--queue-work-codex-sandbox') args.extraEnv.STATE_DAEMON_QUEUE_WORK_CODEX_SANDBOX = next()
    else if (arg === '--queue-work-codex-model') args.extraEnv.STATE_DAEMON_QUEUE_WORK_CODEX_MODEL = next()
    else if (arg === '--queue-work-codex-profile') args.extraEnv.STATE_DAEMON_QUEUE_WORK_CODEX_PROFILE = next()
    else if (arg === '--queue-work-codex-ignore-rules') args.extraEnv.STATE_DAEMON_QUEUE_WORK_CODEX_IGNORE_RULES = '1'
    else if (arg === '--queue-work-handoff-contract') args.extraEnv.STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT = next()
    else if (arg === '--queue-work-github-writeback-mode') args.extraEnv.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE = next()
    else if (arg === '--queue-work-mediated-posting-command') args.extraEnv.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND = next()
    else if (arg === '--queue-work-mediated-posting-args-json') args.extraEnv.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON = next()
    else if (arg === '--queue-work-mediated-posting-timeout-ms') args.extraEnv.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_TIMEOUT_MS = next()
    else if (arg === '--queue-work-fence-queue-ids') args.extraEnv.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS = next()
    else if (arg === '--queue-work-fence-message-ids') args.extraEnv.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS = next()
    else if (arg === '--queue-work-fence-created-after') args.extraEnv.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER = next()
    else if (arg === '--recover-expired-scheduler-claim') args.extraEnv.STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM = '1'
    else if (arg === '--resume-done-finalization') args.extraEnv.STATE_DAEMON_QUEUE_WORK_RESUME_DONE_FINALIZATION = '1'
    else if (arg === '--defer-newer-pending') args.extraEnv.STATE_DAEMON_QUEUE_WORK_DEFER_NEWER_PENDING = '1'
    else if (arg === '--queue-work-residue-policy-file') args.extraEnv.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE = next()
    else if (arg === '--queue-work-fleet-mode') args.extraEnv.STATE_DAEMON_QUEUE_WORK_FLEET_MODE = '1'
    else if (arg === '--queue-work-fleet-decision-ref') args.extraEnv.STATE_DAEMON_QUEUE_WORK_FLEET_DECISION_REF = next()
    else if (arg === '--keep') {
      const value = next()
      if (!/^\d+$/.test(value)) throw new Error('--keep requires a non-negative integer')
      args.keep = Number.parseInt(value, 10)
    }
    else if (arg === '--help' || arg === '-h') args.command = 'help'
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function run(command: string, args: string[], cwd?: string): void {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${proc.exitCode})\n${proc.stderr.toString()}`)
  }
}

function readOutput(command: string, args: string[], cwd?: string): string {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${proc.exitCode})\n${proc.stderr.toString()}`)
  }
  return proc.stdout.toString().trim()
}

function csvArg(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function githubWorkPullerEnvFromArgs(args: ParsedArgs): Record<string, string> {
  return buildGithubWorkPullerLaunchAgentEnv({
    enabled: args.githubWorkPullerEnabled,
    repos: csvArg(args.githubWorkRepos),
    labels: csvArg(args.githubWorkLabels),
    ownerAllowlist: csvArg(args.githubWorkOwnerAllowlist),
    intervalMs: args.githubWorkIntervalMs,
    writebackEnabled: args.githubWorkWritebackEnabled,
    tokenFile: args.githubTokenFile,
  })
}

function githubTokenFileEnvFromArgs(args: ParsedArgs): Record<string, string> {
  return args.githubTokenFile ? { STATE_DAEMON_GITHUB_TOKEN_FILE: resolve(args.githubTokenFile) } : {}
}

function ensureCheckout(plan: ReturnType<typeof buildStateDaemonRestorePlan>): void {
  mkdirSync(plan.restoreRoot, { recursive: true })
  if (!existsSync(plan.checkoutPath)) {
    run('git', ['fetch', 'origin', 'main'])
    run('git', ['worktree', 'add', '--detach', plan.checkoutPath, plan.commit])
  }
  const actual = readOutput('git', ['rev-parse', 'HEAD'], plan.checkoutPath)
  if (actual !== plan.commit) {
    throw new Error(`checkout ${plan.checkoutPath} is ${actual}, expected ${plan.commit}`)
  }
  const status = readOutput('git', ['status', '--short'], plan.checkoutPath)
  if (status.trim()) {
    throw new Error(`checkout ${plan.checkoutPath} is dirty:\n${status}`)
  }
}

function verifyCheckout(plan: ReturnType<typeof buildStateDaemonRestorePlan>): void {
  mkdirSync(plan.logsDir, { recursive: true })
  mkdirSync(dirname(plan.buildOutfile), { recursive: true })
  run('bun', ['install', '--frozen-lockfile', '--no-summary'], plan.checkoutPath)
  run('bun', ['build', '--target', 'bun', 'bin/state-daemon.ts', '--outfile', plan.buildOutfile], plan.checkoutPath)
  const rendered = renderStateDaemonLaunchAgentPlist(plan)
  const validation = validateStateDaemonLaunchAgentConfig(parseStateDaemonLaunchAgentPlist(rendered))
  if (!validation.ok) {
    throw new Error(`generated LaunchAgent failed preflight:\n${JSON.stringify(validation, null, 2)}`)
  }
}

function bootstrap(plistPath: string): void {
  const domain = `gui/${process.getuid?.() ?? readOutput('id', ['-u'])}`
  try {
    run('launchctl', ['bootout', domain, plistPath])
  } catch {
    // bootout is best-effort: first install has nothing loaded yet.
  }
  run('launchctl', ['bootstrap', domain, plistPath])
  run('launchctl', ['kickstart', '-k', `${domain}/${STATE_DAEMON_LAUNCH_AGENT_LABEL}`])
}

async function runQueueWorkCanaryResiduePreflight(
  config: StateDaemonLaunchAgentConfig,
  databaseUrl: string,
): Promise<void> {
  if (!queueWorkSchedulerLaunchAgentEnabled(config.environmentVariables)) return
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await validateQueueWorkCanaryResiduePreflight(client, config.environmentVariables, {
      residuePolicy: loadQueueWorkResiduePolicyFromEnv(config.environmentVariables),
    })
    if (!result.ok) {
      throw new Error(`queue-work canary residue preflight failed:\n${JSON.stringify(result, null, 2)}`)
    }
  } finally {
    await client.end()
  }
}

function commandRestore(args: ParsedArgs): void {
  if (!args.commit) throw new Error('restore requires --commit <sha>')
  const requestedExtraEnv = {
    ...args.extraEnv,
    ...(args.sqlitePath ? { AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: args.sqlitePath } : {}),
    ...githubTokenFileEnvFromArgs(args),
    ...githubWorkPullerEnvFromArgs(args),
  }
  const overlayValidation = validateStateDaemonCanaryOverlayEnv(requestedExtraEnv)
  if (overlayValidation.issues.length > 0) {
    throw new Error(`state-daemon canary overlay failed preflight: ${overlayValidation.issues.map(issue => issue.code).join(',')}`)
  }
  const requestedPlan = buildStateDaemonRestorePlan({
    commit: args.commit,
    restoreRoot: args.restoreRoot,
    launchAgentsDir: args.launchAgentsDir,
    bunPath: args.bunPath,
    databaseUrl: args.databaseUrl,
    extraEnv: requestedExtraEnv,
  })
  const extraEnv = bindRestorePathsToCheckout(requestedExtraEnv, requestedPlan.checkoutPath)
  if (args.bootstrapSafeDefaults) {
    const expected = {
      SHIRUBE_D1_ENABLED: '0',
      SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]',
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
      STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED: '0',
    }
    for (const [key, value] of Object.entries(expected)) {
      if (extraEnv[key] !== value) throw new Error(`bootstrap safe default mismatch: ${key}`)
    }
  }
  const plan = buildStateDaemonRestorePlan({
    commit: args.commit,
    restoreRoot: args.restoreRoot,
    launchAgentsDir: args.launchAgentsDir,
    bunPath: args.bunPath,
    databaseUrl: args.databaseUrl,
    extraEnv,
  })
  if (!args.execute) {
    process.stdout.write(`${JSON.stringify({ dry_run: true, plan, extraEnv }, null, 2)}\n`)
    return
  }

  ensureCheckout(plan)
  verifyCheckout(plan)
  mkdirSync(dirname(plan.plistPath), { recursive: true })
  writeFileSync(plan.tempPlistPath, renderStateDaemonLaunchAgentPlist(plan), 'utf8')
  const stagedConfig = parseStateDaemonLaunchAgentPlist(readFileSync(plan.tempPlistPath, 'utf8'))
  const installedPreflight = validateStateDaemonLaunchAgentConfig(stagedConfig)
  if (!installedPreflight.ok) {
    throw new Error(`staged LaunchAgent failed preflight:\n${JSON.stringify(installedPreflight, null, 2)}`)
  }
  if (queueWorkSchedulerLaunchAgentEnabled(stagedConfig.environmentVariables)) {
    void completeRestoreAfterQueueWorkCanaryResiduePreflight(stagedConfig, plan, args, extraEnv)
    return
  }
  finishRestore(plan, args, extraEnv)
}

async function completeRestoreAfterQueueWorkCanaryResiduePreflight(
  config: StateDaemonLaunchAgentConfig,
  plan: ReturnType<typeof buildStateDaemonRestorePlan>,
  args: ParsedArgs,
  extraEnv: Record<string, string>,
): Promise<void> {
  try {
    await runQueueWorkCanaryResiduePreflight(config, plan.databaseUrl)
    finishRestore(plan, args, extraEnv)
  } catch (err) {
    process.stderr.write(`state-daemon-launchagent: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}

function finishRestore(
  plan: ReturnType<typeof buildStateDaemonRestorePlan>,
  args: ParsedArgs,
  extraEnv: Record<string, string>,
): void {
  renameSync(plan.tempPlistPath, plan.plistPath)
  if (!args.noBootstrap) bootstrap(plan.plistPath)
  process.stdout.write(`${JSON.stringify({ ok: true, plan, extraEnv, bootstrapped: !args.noBootstrap }, null, 2)}\n`)
}

function commandPreflight(args: ParsedArgs): void {
  const plistPath = resolve(args.plist ?? `${process.env.HOME}/Library/LaunchAgents/com.agent-comms.state-daemon.plist`)
  const config = parseStateDaemonLaunchAgentPlist(readFileSync(plistPath, 'utf8'))
  const result = validateStateDaemonLaunchAgentConfig(config)
  process.stdout.write(`${JSON.stringify({ plist: plistPath, ...result }, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}

function commandPrune(args: ParsedArgs): void {
  const root = resolve(args.restoreRoot ?? `${process.env.HOME}/.agent-comms/state-daemon/checkouts`)
  const plistPath = resolve(args.plist ?? `${process.env.HOME}/Library/LaunchAgents/com.agent-comms.state-daemon.plist`)
  const activePlists = existsSync(plistPath) ? [readFileSync(plistPath, 'utf8')] : []
  const targets = planStateDaemonRestorePrune({
    restoreRoot: root,
    checkoutDirs: listStateDaemonRestoreCheckouts(root).sort((a, b) => {
      const am = statSync(a).mtimeMs
      const bm = statSync(b).mtimeMs
      return am === bm ? a.localeCompare(b) : am - bm
    }),
    activeLaunchAgentPlists: activePlists,
    keep: args.keep,
  })
  if (args.execute) {
    for (const target of targets) {
      if (target.action === 'delete') rmSync(target.path, { recursive: true, force: true })
    }
  }
  process.stdout.write(`${JSON.stringify({ dry_run: !args.execute, restoreRoot: root, targets }, null, 2)}\n`)
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2))
  if (args.command === 'help') {
    process.stdout.write(usage())
    return
  }
  if (args.command === 'restore') commandRestore(args)
  else if (args.command === 'preflight') commandPreflight(args)
  else if (args.command === 'prune') commandPrune(args)
}

main().catch((err) => {
  process.stderr.write(`state-daemon-launchagent: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
