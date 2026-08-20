#!/usr/bin/env bun
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export const N1_LAUNCH_AGENT_LABEL = 'com.watchout.agent-comms.n1-slo'
export const N1_LAUNCH_AGENT_INTERVAL_SECONDS = 900

export interface N1LaunchAgentPlan {
  label: typeof N1_LAUNCH_AGENT_LABEL
  plistPath: string
  programArguments: string[]
  startIntervalSeconds: number
  stdoutPath: string
  stderrPath: string
}

export interface BuildN1LaunchAgentPlanInput {
  repoRoot: string
  bunPath: string
  databaseConfig: string
  githubTokenFile: string
  launchAgentsDir?: string
  logDir?: string
  intervalSeconds?: number
}

function requireAbsolute(name: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return resolve(value)
}

export function buildN1LaunchAgentPlan(input: BuildN1LaunchAgentPlanInput): N1LaunchAgentPlan {
  const interval = input.intervalSeconds ?? N1_LAUNCH_AGENT_INTERVAL_SECONDS
  if (!Number.isInteger(interval) || interval < 60) throw new Error('intervalSeconds must be an integer >= 60')
  const repoRoot = requireAbsolute('repoRoot', input.repoRoot)
  const bunPath = requireAbsolute('bunPath', input.bunPath)
  const databaseConfig = requireAbsolute('databaseConfig', input.databaseConfig)
  const launchAgentsDir = requireAbsolute('launchAgentsDir', input.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents'))
  const logDir = requireAbsolute('logDir', input.logDir ?? join(homedir(), '.agent-comms', 'logs'))
  const programArguments = [
    bunPath,
    join(repoRoot, 'scripts', 'n1-slo', 'run.ts'),
    'measure',
    '--database-config',
    databaseConfig,
    '--publish',
  ]
  programArguments.push('--github-token-file', requireAbsolute('githubTokenFile', input.githubTokenFile))
  return {
    label: N1_LAUNCH_AGENT_LABEL,
    plistPath: join(launchAgentsDir, `${N1_LAUNCH_AGENT_LABEL}.plist`),
    programArguments,
    startIntervalSeconds: interval,
    stdoutPath: join(logDir, 'n1-slo.stdout.log'),
    stderrPath: join(logDir, 'n1-slo.stderr.log'),
  }
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function renderN1LaunchAgentPlist(plan: N1LaunchAgentPlan): string {
  const args = plan.programArguments.map(value => `      <string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${plan.startIntervalSeconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(plan.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(plan.stderrPath)}</string>
</dict>
</plist>
`
}

export function validateN1LaunchAgentPlan(plan: N1LaunchAgentPlan): string[] {
  const issues: string[] = []
  const joined = plan.programArguments.join(' ')
  if (plan.label !== N1_LAUNCH_AGENT_LABEL) issues.push('LABEL_MISMATCH')
  if (!plan.programArguments.includes('measure') || !plan.programArguments.includes('--publish')) issues.push('REPORT_COMMAND_MISSING')
  if (!plan.programArguments.includes('--database-config')) issues.push('EXPLICIT_DATABASE_CONFIG_MISSING')
  if (!plan.programArguments.includes('--github-token-file')) issues.push('EXPLICIT_GITHUB_TOKEN_FILE_MISSING')
  if (joined.includes('DATABASE_URL=') || joined.includes('DISCORD_TOKEN') || joined.includes('FLEET_RUNTIME')) issues.push('PROTECTED_ENV_PRESENT')
  if (plan.startIntervalSeconds < 60) issues.push('INTERVAL_TOO_SHORT')
  return issues
}

function parseCli(argv: string[]): { execute: boolean; input: BuildN1LaunchAgentPlanInput } {
  const command = argv[0]
  if (command !== 'render' && command !== 'install') throw new Error('command must be render or install')
  let execute = false
  const values: Record<string, string> = {}
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--execute') { execute = true; continue }
    const value = argv[++index]
    if (!value) throw new Error(`${arg} requires a value`)
    values[arg] = value
  }
  if (!values['--repo-root'] || !values['--bun-path'] || !values['--database-config'] || !values['--github-token-file']) {
    throw new Error('--repo-root, --bun-path, --database-config, and --github-token-file are required')
  }
  return {
    execute: command === 'install' && execute,
    input: {
      repoRoot: values['--repo-root'],
      bunPath: values['--bun-path'],
      databaseConfig: values['--database-config'],
      githubTokenFile: values['--github-token-file'],
      launchAgentsDir: values['--launch-agents-dir'],
      logDir: values['--log-dir'],
      intervalSeconds: values['--interval-seconds'] ? Number(values['--interval-seconds']) : undefined,
    },
  }
}

async function main(): Promise<void> {
  try {
    const { execute, input } = parseCli(process.argv.slice(2))
    const plan = buildN1LaunchAgentPlan(input)
    const issues = validateN1LaunchAgentPlan(plan)
    if (issues.length) throw new Error(`invalid launchagent plan: ${issues.join(',')}`)
    const plist = renderN1LaunchAgentPlist(plan)
    if (execute) {
      for (const [name, path] of [['database config', input.databaseConfig], ['GitHub token file', input.githubTokenFile]] as const) {
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name} does not exist or is not a file`)
      }
      mkdirSync(dirname(plan.plistPath), { recursive: true })
      mkdirSync(dirname(plan.stdoutPath), { recursive: true })
      const temporaryPath = `${plan.plistPath}.tmp-${process.pid}`
      writeFileSync(temporaryPath, plist, { mode: 0o600 })
      renameSync(temporaryPath, plan.plistPath)
      const domain = `gui/${process.getuid?.() ?? 0}`
      spawnSync('launchctl', ['bootout', domain, plan.plistPath], { stdio: 'ignore' })
      const loaded = spawnSync('launchctl', ['bootstrap', domain, plan.plistPath], { encoding: 'utf8' })
      if (loaded.status !== 0) throw new Error(`launchctl bootstrap failed: ${loaded.stderr.trim()}`)
    }
    process.stdout.write(JSON.stringify({ ok: true, execute, plan, plist }, null, 2) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n')
    process.exitCode = 1
  }
}

if (import.meta.main) void main()
