#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  STATE_DAEMON_LAUNCH_AGENT_LABEL,
  buildGithubWorkPullerLaunchAgentEnv,
  buildStateDaemonRestorePlan,
  listStateDaemonRestoreCheckouts,
  parseStateDaemonLaunchAgentPlist,
  planStateDaemonRestorePrune,
  renderStateDaemonLaunchAgentPlist,
  validateStateDaemonLaunchAgentConfig,
} from '../core/state-daemon/launchagent'

type ParsedArgs = {
  command: 'restore' | 'preflight' | 'prune' | 'help'
  execute: boolean
  noBootstrap: boolean
  commit?: string
  restoreRoot?: string
  launchAgentsDir?: string
  plist?: string
  bunPath?: string
  databaseUrl?: string
  keep?: number
  githubWorkPullerEnabled: boolean
  githubWorkRepos?: string
  githubWorkLabels?: string
  githubWorkOwnerAllowlist?: string
  githubWorkIntervalMs?: number
  githubWorkWritebackEnabled: boolean
  githubTokenFile?: string
}

function usage(): string {
  return `state-daemon LaunchAgent restore helper

Usage:
  bun scripts/state-daemon-launchagent.ts restore --commit <sha> [--execute] [--no-bootstrap]
    [--github-work-puller-enabled --github-work-repos <owner/repo>
     --github-work-labels <canary:label>
     --github-work-owner-allowlist <agent>
     --github-token-file <path>]
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
    githubWorkPullerEnabled: false,
    githubWorkWritebackEnabled: false,
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

function verifyCheckout(plan: ReturnType<typeof buildStateDaemonRestorePlan>, extraEnv: Record<string, string>): void {
  mkdirSync(plan.logsDir, { recursive: true })
  mkdirSync(dirname(plan.buildOutfile), { recursive: true })
  run('bun', ['install', '--frozen-lockfile', '--no-summary'], plan.checkoutPath)
  run('bun', ['build', '--target', 'bun', 'bin/state-daemon.ts', '--outfile', plan.buildOutfile], plan.checkoutPath)
  const rendered = renderStateDaemonLaunchAgentPlist(plan, extraEnv)
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

function commandRestore(args: ParsedArgs): void {
  if (!args.commit) throw new Error('restore requires --commit <sha>')
  const plan = buildStateDaemonRestorePlan({
    commit: args.commit,
    restoreRoot: args.restoreRoot,
    launchAgentsDir: args.launchAgentsDir,
    bunPath: args.bunPath,
    databaseUrl: args.databaseUrl,
  })
  const extraEnv = githubWorkPullerEnvFromArgs(args)
  if (!args.execute) {
    process.stdout.write(`${JSON.stringify({ dry_run: true, plan, extraEnv }, null, 2)}\n`)
    return
  }

  ensureCheckout(plan)
  verifyCheckout(plan, extraEnv)
  mkdirSync(dirname(plan.plistPath), { recursive: true })
  writeFileSync(plan.tempPlistPath, renderStateDaemonLaunchAgentPlist(plan, extraEnv), 'utf8')
  const installedPreflight = validateStateDaemonLaunchAgentConfig(
    parseStateDaemonLaunchAgentPlist(readFileSync(plan.tempPlistPath, 'utf8')),
  )
  if (!installedPreflight.ok) {
    throw new Error(`staged LaunchAgent failed preflight:\n${JSON.stringify(installedPreflight, null, 2)}`)
  }
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
