import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import {
  classifyQueueWorkResidueRows,
  loadQueueWorkResiduePolicyFile,
  type QueueWorkResiduePolicy,
  type QueueWorkResidueRow,
} from './queue-work-residue-policy'

export const STATE_DAEMON_LAUNCH_AGENT_LABEL = 'com.agent-comms.state-daemon'
export const STATE_DAEMON_PLIST_NAME = `${STATE_DAEMON_LAUNCH_AGENT_LABEL}.plist`
export const DEFAULT_STATE_DAEMON_BUN_PATH = '/Users/yuji/.bun/bin/bun'
export const DEFAULT_STATE_DAEMON_DATABASE_URL = 'postgresql:///agent_comms?host=/tmp'
export const DEFAULT_STATE_DAEMON_DENYLIST = 'adf-dev,arc-test,auditor-test,ceo,codex-test,cto,cto-test,cto-test2,dev-001,hotfix-test,iyasaka-arc,test,test-probe,unknown'

export type StateDaemonLaunchAgentConfig = {
  label: string | null
  programArguments: string[]
  workingDirectory: string | null
  standardOutPath: string | null
  standardErrorPath: string | null
  environmentVariables: Record<string, string>
}

export type StateDaemonRestorePlan = {
  commit: string
  restoreRoot: string
  checkoutPath: string
  entryPath: string
  logsDir: string
  buildOutfile: string
  plistPath: string
  tempPlistPath: string
  bunPath: string
  databaseUrl: string
  agentDenylist: string
  extraEnv: Record<string, string>
}

export type StateDaemonGithubWorkPullerActivationOptions = {
  enabled: boolean
  repos?: string[]
  labels?: string[]
  ownerAllowlist?: string[]
  intervalMs?: number
  writebackEnabled?: boolean
  tokenFile?: string | null
}

export type StateDaemonPreflightIssue = {
  code: string
  message: string
  path?: string
}

export type StateDaemonPreflightResult = {
  ok: boolean
  errors: StateDaemonPreflightIssue[]
  warnings: StateDaemonPreflightIssue[]
}

export type QueueWorkCanaryResidueRow = {
  id: number | string
  agent_id: string
  message_id: string | null
  payload?: string | null
  status: string
  created_at: string | Date
  claimed_by: string | null
  claimed_at: string | Date | null
  claim_expires_at: string | Date | null
}

export type QueueWorkCanaryResidueDb = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export type QueueWorkCanaryResiduePreflightResult = StateDaemonPreflightResult & {
  residues: QueueWorkCanaryResidueRow[]
}

export type QueueWorkResiduePolicyPreflightOptions = {
  limit?: number
  residuePolicy?: QueueWorkResiduePolicy | null
}

export type PathProbe = {
  exists(path: string): boolean
  isDirectory(path: string): boolean
  isFile(path: string): boolean
  isExecutable(path: string): boolean
}

export type StateDaemonPruneTarget = {
  path: string
  action: 'delete' | 'keep' | 'protect'
  reason: string
}

export function defaultStateDaemonRestoreRoot(home = homedir()): string {
  return join(home, '.agent-comms', 'state-daemon', 'checkouts')
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function keyString(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`))
  return match ? xmlUnescape(match[1]) : null
}

function keyDict(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<dict>([\\s\\S]*?)</dict>`))
  return match ? match[1] : null
}

function keyArray(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`))
  return match ? match[1] : null
}

function parseStringArray(body: string | null): string[] {
  if (!body) return []
  return [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]))
}

function parseStringDict(body: string | null): Record<string, string> {
  if (!body) return {}
  const env: Record<string, string> = {}
  const entries = [...body.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)]
  for (const [, key, value] of entries) {
    env[xmlUnescape(key)] = xmlUnescape(value)
  }
  return env
}

export function parseStateDaemonLaunchAgentPlist(plist: string): StateDaemonLaunchAgentConfig {
  return {
    label: keyString(plist, 'Label'),
    programArguments: parseStringArray(keyArray(plist, 'ProgramArguments')),
    workingDirectory: keyString(plist, 'WorkingDirectory'),
    standardOutPath: keyString(plist, 'StandardOutPath'),
    standardErrorPath: keyString(plist, 'StandardErrorPath'),
    environmentVariables: parseStringDict(keyDict(plist, 'EnvironmentVariables')),
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent)
  const resolvedChild = resolve(child)
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${sep}`)
}

export function isEphemeralLaunchAgentPath(path: string): boolean {
  const resolved = resolve(path)
  return resolved === '/tmp'
    || resolved === '/private/tmp'
    || resolved.startsWith('/tmp/')
    || resolved.startsWith('/private/tmp/')
}

export function buildStateDaemonRestorePlan(options: {
  commit: string
  restoreRoot?: string
  launchAgentsDir?: string
  bunPath?: string
  databaseUrl?: string
  agentDenylist?: string
  extraEnv?: Record<string, string>
  pid?: number
}): StateDaemonRestorePlan {
  const commit = options.commit.trim()
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error(`commit must be a git SHA, got ${JSON.stringify(options.commit)}`)
  }
  const restoreRoot = resolve(options.restoreRoot ?? defaultStateDaemonRestoreRoot())
  const checkoutPath = join(restoreRoot, commit)
  const buildArtifactsRoot = join(dirname(restoreRoot), 'build-artifacts', commit)
  const logsDir = join(checkoutPath, 'logs')
  const launchAgentsDir = resolve(options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents'))
  const plistPath = join(launchAgentsDir, STATE_DAEMON_PLIST_NAME)
  const pid = options.pid ?? process.pid
  return {
    commit,
    restoreRoot,
    checkoutPath,
    entryPath: join(checkoutPath, 'bin', 'state-daemon.ts'),
    logsDir,
    buildOutfile: join(buildArtifactsRoot, 'state-daemon-build.js'),
    plistPath,
    tempPlistPath: join(launchAgentsDir, `.${STATE_DAEMON_PLIST_NAME}.${pid}.tmp`),
    bunPath: options.bunPath ?? DEFAULT_STATE_DAEMON_BUN_PATH,
    databaseUrl: options.databaseUrl ?? DEFAULT_STATE_DAEMON_DATABASE_URL,
    agentDenylist: options.agentDenylist ?? DEFAULT_STATE_DAEMON_DENYLIST,
    extraEnv: options.extraEnv ?? {},
  }
}

export function renderStateDaemonLaunchAgentPlist(plan: StateDaemonRestorePlan, extraEnv: Record<string, string> = {}): string {
  const mergedExtraEnv = { ...plan.extraEnv, ...extraEnv }
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: plan.databaseUrl,
    STATE_DAEMON_CODEX_RUNNER_ENABLED: '1',
    STATE_DAEMON_CODEX_RUNNER_DATABASE_URL: plan.databaseUrl,
    STATE_DAEMON_AGENT_DENYLIST: plan.agentDenylist,
    STATE_DAEMON_ALERT_CHANNEL: '1487368919613444156',
    STATE_DAEMON_RESTORE_MANAGED: '1',
    STATE_DAEMON_RESTORE_COMMIT: plan.commit,
    STATE_DAEMON_RESTORE_ROOT: plan.restoreRoot,
    PGUSER: process.env.PGUSER ?? process.env.USER ?? 'yuji',
    USER: process.env.USER ?? 'yuji',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    ...mergedExtraEnv,
  }
  if (!mergedExtraEnv.STATE_DAEMON_AGENT_ALLOWLIST) delete env.STATE_DAEMON_AGENT_ALLOWLIST

  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(STATE_DAEMON_LAUNCH_AGENT_LABEL)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(plan.bunPath)}</string>
    <string>${xmlEscape(plan.entryPath)}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(plan.checkoutPath)}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${xmlEscape(join(plan.logsDir, 'state-daemon.out.log'))}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(plan.logsDir, 'state-daemon.err.log'))}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

function normalizeCsvValues(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean)
}

function parseCsvValue(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function isCanaryLabel(label: string): boolean {
  return label.trim().toLowerCase().startsWith('canary:')
}

export function queueWorkSchedulerLaunchAgentEnabled(env: Record<string, string>): boolean {
  const value = env.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED
  return value === '1' || value?.toLowerCase() === 'true'
}

export function buildGithubWorkPullerLaunchAgentEnv(
  options: StateDaemonGithubWorkPullerActivationOptions,
): Record<string, string> {
  if (!options.enabled) return {}
  const repos = normalizeCsvValues(options.repos)
  const labels = normalizeCsvValues(options.labels)
  const ownerAllowlist = normalizeCsvValues(options.ownerAllowlist)
  const tokenFile = options.tokenFile?.trim()
  if (repos.length !== 1) {
    throw new Error('bounded GitHub work puller activation requires exactly one repo')
  }
  if (labels.length !== 1 || !isCanaryLabel(labels[0])) {
    throw new Error('bounded GitHub work puller activation requires exactly one canary:* label')
  }
  if (ownerAllowlist.length !== 1) {
    throw new Error('bounded GitHub work puller activation requires exactly one owner allowlist entry')
  }
  if (!tokenFile) {
    throw new Error('bounded GitHub work puller activation requires --github-token-file')
  }
  const env: Record<string, string> = {
    STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED: '1',
    STATE_DAEMON_GITHUB_WORK_REPOS: repos.join(','),
    STATE_DAEMON_GITHUB_WORK_LABELS: labels.join(','),
    STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST: ownerAllowlist.join(','),
    STATE_DAEMON_GITHUB_TOKEN_FILE: resolve(tokenFile),
  }
  if (options.intervalMs !== undefined) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error('bounded GitHub work puller activation requires a positive interval')
    }
    env.STATE_DAEMON_GITHUB_WORK_INTERVAL_MS = String(Math.round(options.intervalMs))
  }
  if (options.writebackEnabled) {
    env.STATE_DAEMON_GITHUB_WORK_WRITEBACK_ENABLED = '1'
  }
  return env
}

export function validateStateDaemonLaunchAgentConfig(
  config: StateDaemonLaunchAgentConfig,
  options: {
    probe?: PathProbe
    allowRestoreOwnedTemp?: boolean
    restoreRoot?: string | null
  } = {},
): StateDaemonPreflightResult {
  const probe = options.probe ?? {
    exists: existsSync,
    isDirectory: (path: string) => {
      try { return statSync(path).isDirectory() } catch { return false }
    },
    isFile: (path: string) => {
      try { return statSync(path).isFile() } catch { return false }
    },
    isExecutable: (path: string) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
  }
  const errors: StateDaemonPreflightIssue[] = []
  const warnings: StateDaemonPreflightIssue[] = []
  const entry = config.programArguments[1] ?? null
  const workingDirectory = config.workingDirectory
  const restoreRoot = options.restoreRoot ?? config.environmentVariables.STATE_DAEMON_RESTORE_ROOT ?? null
  const restoreOwned = config.environmentVariables.STATE_DAEMON_RESTORE_MANAGED === '1'
  const env = config.environmentVariables

  if (config.label !== STATE_DAEMON_LAUNCH_AGENT_LABEL) {
    errors.push({
      code: 'state_daemon_label_mismatch',
      message: `LaunchAgent label must be ${STATE_DAEMON_LAUNCH_AGENT_LABEL}`,
    })
  }
  if (config.programArguments.length < 2) {
    errors.push({
      code: 'program_arguments_entry_missing',
      message: 'ProgramArguments[1] must point to bin/state-daemon.ts or a verified state-daemon artifact',
    })
  }
  const executable = config.programArguments[0] ?? null
  if (!executable || !probe.exists(executable)) {
    errors.push({
      code: 'bun_path_missing',
      message: 'ProgramArguments[0] does not exist; refusing launchd load/kickstart because launchd cannot exec bun',
      path: executable ?? undefined,
    })
  } else if (!probe.isFile(executable)) {
    errors.push({
      code: 'bun_path_not_file',
      message: 'ProgramArguments[0] must be a regular executable file; refusing launchd load/kickstart because launchd cannot exec bun',
      path: executable,
    })
  } else if (!probe.isExecutable(executable)) {
    errors.push({
      code: 'bun_path_not_executable',
      message: 'ProgramArguments[0] is not executable; refusing launchd load/kickstart because launchd cannot exec bun',
      path: executable,
    })
  }
  if (!entry || !probe.exists(entry)) {
    errors.push({
      code: 'state_daemon_entry_missing',
      message: 'ProgramArguments[1] does not exist; refusing launchd load/kickstart to avoid Module not found crash-loop',
      path: entry ?? undefined,
    })
  }
  if (!workingDirectory || !probe.exists(workingDirectory) || !probe.isDirectory(workingDirectory)) {
    errors.push({
      code: 'working_directory_missing',
      message: 'WorkingDirectory does not exist; refusing launchd load/kickstart',
      path: workingDirectory ?? undefined,
    })
  }

  for (const path of [entry, workingDirectory]) {
    if (!path || !isEphemeralLaunchAgentPath(path)) continue
    const restoreOwnedTemp = Boolean(
      options.allowRestoreOwnedTemp
      && restoreOwned
      && restoreRoot
      && isPathInside(restoreRoot, path),
    )
    if (!restoreOwnedTemp) {
      errors.push({
        code: 'ephemeral_launchagent_path',
        message: 'LaunchAgent target must not point at an unowned /tmp or /private/tmp checkout',
        path,
      })
    }
  }

  if (entry && workingDirectory && !isPathInside(workingDirectory, entry)) {
    warnings.push({
      code: 'entry_outside_working_directory',
      message: 'ProgramArguments[1] is outside WorkingDirectory; verify the artifact/check-out ownership contract',
      path: entry,
    })
  }

  if (env.STATE_DAEMON_GITHUB_TOKEN || env.GITHUB_TOKEN) {
    errors.push({
      code: 'github_token_embedded_in_launchagent',
      message: 'LaunchAgent must not embed raw GitHub token values; use STATE_DAEMON_GITHUB_TOKEN_FILE',
    })
  }

  if (env.STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED === '1') {
    const repos = parseCsvValue(env.STATE_DAEMON_GITHUB_WORK_REPOS)
    const labels = parseCsvValue(env.STATE_DAEMON_GITHUB_WORK_LABELS)
    const ownerAllowlist = parseCsvValue(env.STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST)
    const tokenFile = env.STATE_DAEMON_GITHUB_TOKEN_FILE?.trim()
    if (repos.length !== 1) {
      errors.push({
        code: 'github_work_puller_requires_single_repo',
        message: 'Bounded GitHub work puller LaunchAgent activation requires exactly one repo',
      })
    }
    if (labels.length !== 1 || !isCanaryLabel(labels[0] ?? '')) {
      errors.push({
        code: 'github_work_puller_requires_single_canary_label',
        message: 'Bounded GitHub work puller LaunchAgent activation requires exactly one canary:* label',
      })
    }
    if (ownerAllowlist.length !== 1) {
      errors.push({
        code: 'github_work_puller_requires_single_owner_allowlist',
        message: 'Bounded GitHub work puller LaunchAgent activation requires exactly one owner allowlist entry',
      })
    }
    if (!tokenFile) {
      errors.push({
        code: 'github_work_puller_token_file_required',
        message: 'Bounded GitHub work puller LaunchAgent activation requires STATE_DAEMON_GITHUB_TOKEN_FILE',
      })
    } else if (!probe.exists(tokenFile)) {
      errors.push({
        code: 'github_work_puller_token_file_missing',
        message: 'STATE_DAEMON_GITHUB_TOKEN_FILE does not exist',
        path: tokenFile,
      })
    } else if (!probe.isFile(tokenFile)) {
      errors.push({
        code: 'github_work_puller_token_file_not_file',
        message: 'STATE_DAEMON_GITHUB_TOKEN_FILE must point to a regular file',
        path: tokenFile,
      })
    }
  }

  const queueWorkSchedulerEnabled = queueWorkSchedulerLaunchAgentEnabled(env)
  if (queueWorkSchedulerEnabled) {
    const allowlist = (env.STATE_DAEMON_AGENT_ALLOWLIST ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (allowlist.length !== 1) {
      errors.push({
        code: 'queue_work_scheduler_requires_single_agent_allowlist',
        message: 'Queue-work scheduler activation must specify exactly one STATE_DAEMON_AGENT_ALLOWLIST entry for bounded canary launch.',
      })
    }

    const fenceQueueIds = (env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const fenceMessageIds = (env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const fenceCreatedAfter = env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER?.trim()
    if (fenceQueueIds.length === 0 && fenceMessageIds.length === 0 && !fenceCreatedAfter) {
      errors.push({
        code: 'queue_work_scheduler_requires_canary_fence',
        message: 'Queue-work scheduler activation must specify a queue-work fence so existing non-terminal rows cannot be processed by a bounded canary.',
      })
    }
    if (fenceQueueIds.some((item) => !/^[1-9]\d*$/.test(item))) {
      errors.push({
        code: 'queue_work_fence_queue_ids_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS must contain positive integer queue ids.',
      })
    }
    if (fenceCreatedAfter && !Number.isFinite(Date.parse(fenceCreatedAfter))) {
      errors.push({
        code: 'queue_work_fence_created_after_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER must be a valid timestamp.',
      })
    }
    const residuePolicyFile = env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE?.trim()
    if (residuePolicyFile) {
      if (!probe.exists(residuePolicyFile)) {
        errors.push({
          code: 'queue_work_residue_policy_file_missing',
          message: 'STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE does not exist.',
          path: residuePolicyFile,
        })
      } else if (!probe.isFile(residuePolicyFile)) {
        errors.push({
          code: 'queue_work_residue_policy_file_not_file',
          message: 'STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE must point to a regular file.',
          path: residuePolicyFile,
        })
      }
    }

    const runtime = env.STATE_DAEMON_QUEUE_WORK_RUNTIME ?? env.AUN_QUEUE_WORK_RUNTIME
    const command = env.STATE_DAEMON_QUEUE_WORK_COMMAND ?? env.AUN_QUEUE_WORK_COMMAND
    const effectiveRuntime = runtime ?? (command ? 'command-json' : null)
    const handoffContract = env.STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT
      ?? env.AUN_QUEUE_WORK_HANDOFF_CONTRACT
      ?? null
    const githubWritebackMode = env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? env.AUN_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? null
    const mediatedPostingCommand = env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND
      ?? env.AUN_QUEUE_WORK_MEDIATED_POSTING_COMMAND
      ?? null
    if (!effectiveRuntime) {
      errors.push({
        code: 'queue_work_runtime_unconfigured',
        message: 'Queue-work scheduler activation requires STATE_DAEMON_QUEUE_WORK_RUNTIME or STATE_DAEMON_QUEUE_WORK_COMMAND before launch.',
      })
    }
    if (effectiveRuntime === 'command-json' && !command) {
      errors.push({
        code: 'queue_work_command_missing',
        message: 'STATE_DAEMON_QUEUE_WORK_RUNTIME=command-json requires STATE_DAEMON_QUEUE_WORK_COMMAND.',
      })
    }
    if (effectiveRuntime === 'codex-exec') {
      const schemaPath = env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
        ?? env.AUN_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
        ?? (workingDirectory ? join(workingDirectory, 'schemas', 'queue-work-result-v1.schema.json') : null)
      if (!schemaPath || !probe.exists(schemaPath) || !probe.isFile(schemaPath)) {
        errors.push({
          code: 'queue_work_codex_schema_missing',
          message: 'STATE_DAEMON_QUEUE_WORK_RUNTIME=codex-exec requires a readable queue_work_result_v1 schema file.',
          path: schemaPath ?? undefined,
        })
      }
    }
    if (handoffContract && !['plain_queue_work', 'github_backed_role_handoff'].includes(handoffContract)) {
      errors.push({
        code: 'queue_work_handoff_contract_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT must be plain_queue_work or github_backed_role_handoff.',
      })
    }
    if (githubWritebackMode && !['none', 'mediated'].includes(githubWritebackMode)) {
      errors.push({
        code: 'queue_work_github_writeback_mode_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE must be none or mediated.',
      })
    }
    if (handoffContract === 'github_backed_role_handoff') {
      if (githubWritebackMode !== 'mediated') {
        errors.push({
          code: 'queue_work_github_handoff_requires_mediated_posting',
          message: 'GitHub-backed queue-work handoffs require STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE=mediated before activation.',
        })
      }
      if (!mediatedPostingCommand) {
        errors.push({
          code: 'queue_work_mediated_posting_command_missing',
          message: 'GitHub-backed mediated queue-work handoffs require STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND.',
        })
      } else if (!probe.exists(mediatedPostingCommand)) {
        errors.push({
          code: 'queue_work_mediated_posting_command_not_found',
          message: 'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND does not exist.',
          path: mediatedPostingCommand,
        })
      } else if (!probe.isFile(mediatedPostingCommand)) {
        errors.push({
          code: 'queue_work_mediated_posting_command_not_file',
          message: 'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND must point to a regular file.',
          path: mediatedPostingCommand,
        })
      }
      const postingArgsJson = env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON
        ?? env.AUN_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON
      if (postingArgsJson) {
        try {
          const parsed = JSON.parse(postingArgsJson)
          if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            throw new Error('not string array')
          }
        } catch {
          errors.push({
            code: 'queue_work_mediated_posting_args_invalid',
            message: 'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON must be a JSON string array.',
          })
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function queueWorkFenceConditionsFromEnv(env: Record<string, string>, params: unknown[], alias: string): string[] {
  const conditions: string[] = []
  const fenceQueueIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS)
  const fenceMessageIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS)
  const fenceCreatedAfter = env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER?.trim()
  if (fenceQueueIds.length > 0) {
    params.push(fenceQueueIds.map((item) => Number.parseInt(item, 10)))
    conditions.push(`COALESCE(${alias}.id = ANY($${params.length}::bigint[]), false)`)
  }
  if (fenceMessageIds.length > 0) {
    params.push(fenceMessageIds)
    conditions.push(`COALESCE(${alias}.message_id = ANY($${params.length}::text[]), false)`)
  }
  if (fenceCreatedAfter) {
    params.push(fenceCreatedAfter)
    conditions.push(`COALESCE(${alias}.created_at >= $${params.length}::timestamptz, false)`)
  }
  return conditions
}

export function loadQueueWorkResiduePolicyFromEnv(env: Record<string, string>): QueueWorkResiduePolicy | null {
  const policyFile = env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE?.trim()
  return policyFile ? loadQueueWorkResiduePolicyFile(policyFile) : null
}

export async function validateQueueWorkCanaryResiduePreflight(
  db: QueueWorkCanaryResidueDb,
  env: Record<string, string>,
  options: QueueWorkResiduePolicyPreflightOptions = {},
): Promise<QueueWorkCanaryResiduePreflightResult> {
  const errors: StateDaemonPreflightIssue[] = []
  const warnings: StateDaemonPreflightIssue[] = []
  if (!queueWorkSchedulerLaunchAgentEnabled(env)) {
    return { ok: true, errors, warnings, residues: [] }
  }

  const allowlist = parseCsvValue(env.STATE_DAEMON_AGENT_ALLOWLIST)
  const fenceQueueIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS)
  const fenceMessageIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS)
  const fenceCreatedAfter = env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER?.trim()
  if (
    allowlist.length !== 1
    || (fenceQueueIds.length === 0 && fenceMessageIds.length === 0 && !fenceCreatedAfter)
    || fenceQueueIds.some((item) => !/^[1-9]\d*$/.test(item))
    || (fenceCreatedAfter && !Number.isFinite(Date.parse(fenceCreatedAfter)))
  ) {
    return { ok: true, errors, warnings, residues: [] }
  }

  const params: unknown[] = [allowlist[0]]
  const fenceConditions = queueWorkFenceConditionsFromEnv(env, params, 'mq')
  if (fenceConditions.length === 0) {
    return { ok: true, errors, warnings, residues: [] }
  }
  const limit = options.limit ?? 20
  params.push(limit)
  try {
    const result = await db.query<QueueWorkCanaryResidueRow>(
      `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.created_at,
              mq.claimed_by, mq.claimed_at, mq.claim_expires_at
         FROM message_queue mq
        WHERE mq.agent_id = $1
          AND mq.status IN ('pending', 'received', 'in_progress')
          AND NOT (${fenceConditions.join(' AND ')})
        ORDER BY mq.created_at ASC, mq.id ASC
        LIMIT $${params.length}`,
      params,
    )
    const residues = result.rows ?? []
    if (residues.length > 0) {
      if (!options.residuePolicy) {
        errors.push({
          code: 'queue_work_residue_policy_missing',
          message: `Queue-work scheduler activation found ${residues.length} non-fenced non-terminal row(s) for ${allowlist[0]} but no STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE was provided: ${
            residues.map((row) => `${row.id}:${row.status}:${row.message_id ?? '(no-message-id)'}`).join(', ')
          }. Provide an exact-row governed residue policy or close/rework under separate authorization before LaunchAgent mutation.`,
        })
      } else {
        const policyReport = classifyQueueWorkResidueRows(
          options.residuePolicy,
          residues as QueueWorkResidueRow[],
        )
        for (const blocker of policyReport.blockers) {
          errors.push({
            code: blocker.code,
            message: `${blocker.message}${blocker.mismatches?.length ? `: ${blocker.mismatches.join('; ')}` : ''}`,
          })
        }
      }
    }
    return { ok: errors.length === 0, errors, warnings, residues }
  } catch (err) {
    errors.push({
      code: 'queue_work_canary_residue_preflight_db_error',
      message: `Queue-work scheduler canary residue preflight failed; refusing LaunchAgent mutation: ${err instanceof Error ? err.message : String(err)}`,
    })
    return { ok: false, errors, warnings, residues: [] }
  }
}

export function protectedPathsFromLaunchAgentPlists(plists: string[]): string[] {
  const protectedPaths = new Set<string>()
  for (const plist of plists) {
    const config = parseStateDaemonLaunchAgentPlist(plist)
    if (config.label !== STATE_DAEMON_LAUNCH_AGENT_LABEL) continue
    const entry = config.programArguments[1]
    if (entry) {
      protectedPaths.add(resolve(entry))
      protectedPaths.add(resolve(dirname(dirname(entry))))
    }
    if (config.workingDirectory) {
      protectedPaths.add(resolve(config.workingDirectory))
    }
  }
  return [...protectedPaths].sort()
}

function pathIntersectsProtected(candidate: string, protectedPath: string): boolean {
  return isPathInside(candidate, protectedPath) || isPathInside(protectedPath, candidate)
}

export function planStateDaemonRestorePrune(input: {
  restoreRoot: string
  checkoutDirs: string[]
  activeLaunchAgentPlists?: string[]
  keep?: number
}): StateDaemonPruneTarget[] {
  const restoreRoot = resolve(input.restoreRoot)
  const keep = Number.isFinite(input.keep) && input.keep !== undefined && input.keep >= 0
    ? Math.floor(input.keep)
    : 3
  const protectedPaths = protectedPathsFromLaunchAgentPlists(input.activeLaunchAgentPlists ?? [])
  const dirs = [...input.checkoutDirs]
    .map((path) => resolve(path))
    .filter((path) => isPathInside(restoreRoot, path) && path !== restoreRoot)

  return dirs.map((path, index) => {
    if (protectedPaths.some((protectedPath) => pathIntersectsProtected(path, protectedPath))) {
      return { path, action: 'protect', reason: 'referenced_by_active_launchagent' }
    }
    if (index >= Math.max(0, dirs.length - keep)) {
      return { path, action: 'keep', reason: `within_keep_last_${keep}` }
    }
    return { path, action: 'delete', reason: 'older_than_keep_window' }
  })
}

export function listStateDaemonRestoreCheckouts(restoreRoot: string): string[] {
  try {
    return readdirSync(restoreRoot)
      .map((name) => join(restoreRoot, name))
      .filter((path) => {
        try { return statSync(path).isDirectory() } catch { return false }
      })
  } catch {
    return []
  }
}
