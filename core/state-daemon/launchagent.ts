import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

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

export type PathProbe = {
  exists(path: string): boolean
  isDirectory(path: string): boolean
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
  pid?: number
}): StateDaemonRestorePlan {
  const commit = options.commit.trim()
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error(`commit must be a git SHA, got ${JSON.stringify(options.commit)}`)
  }
  const restoreRoot = resolve(options.restoreRoot ?? defaultStateDaemonRestoreRoot())
  const checkoutPath = join(restoreRoot, commit)
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
    buildOutfile: join(checkoutPath, '.agent-comms-restore', 'state-daemon-build.js'),
    plistPath,
    tempPlistPath: join(launchAgentsDir, `.${STATE_DAEMON_PLIST_NAME}.${pid}.tmp`),
    bunPath: options.bunPath ?? DEFAULT_STATE_DAEMON_BUN_PATH,
    databaseUrl: options.databaseUrl ?? DEFAULT_STATE_DAEMON_DATABASE_URL,
    agentDenylist: options.agentDenylist ?? DEFAULT_STATE_DAEMON_DENYLIST,
  }
}

export function renderStateDaemonLaunchAgentPlist(plan: StateDaemonRestorePlan, extraEnv: Record<string, string> = {}): string {
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
    ...extraEnv,
  }
  delete env.STATE_DAEMON_AGENT_ALLOWLIST

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
  }
  const errors: StateDaemonPreflightIssue[] = []
  const warnings: StateDaemonPreflightIssue[] = []
  const entry = config.programArguments[1] ?? null
  const workingDirectory = config.workingDirectory
  const restoreRoot = options.restoreRoot ?? config.environmentVariables.STATE_DAEMON_RESTORE_ROOT ?? null
  const restoreOwned = config.environmentVariables.STATE_DAEMON_RESTORE_MANAGED === '1'

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

  return { ok: errors.length === 0, errors, warnings }
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
