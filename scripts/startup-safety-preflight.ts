#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  evaluateStartupSafety,
  extractStartupIdentity,
  type StartupPortListenerEvidence,
  type StartupTmuxRuntimeEvidence,
  type CodexPostStartEnterPolicy,
} from '../core/startup-safety'
import {
  observeTmuxRuntime,
  parseProcessList,
  type TmuxPaneSnapshot,
} from '../core/tmux-runtime-inspector'

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx < 0) return null
  return process.argv[idx + 1] ?? null
}

function splitList(value: string | null): string[] {
  return (value ?? '').split(':').map((item) => item.trim()).filter(Boolean)
}

function realpathIfExists(path: string | null): string | null {
  if (!path) return null
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path)
  } catch {
    return resolve(path)
  }
}

function run(cmd: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 3000 })
  return { status: result.status ?? -1, stdout: result.stdout ?? '' }
}

function collectPortListeners(port: number | null): StartupPortListenerEvidence[] {
  if (!port) return []
  const pids = run('lsof', ['-nP', '-tiTCP:' + String(port), '-sTCP:LISTEN']).stdout
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
  return pids.map((pid) => {
    const command = run('ps', ['eww', '-p', String(pid), '-o', 'command=']).stdout.trim()
    const ppid = Number.parseInt(run('ps', ['-o', 'ppid=', '-p', String(pid)]).stdout.trim(), 10)
    const identity = extractStartupIdentity(command)
    return {
      pid,
      port,
      ppid: Number.isInteger(ppid) ? ppid : null,
      command,
      observed_agent_id: identity.agentId,
      orphan: ppid === 1,
    }
  })
}

function collectTmuxEvidence(sessionName: string | null): StartupTmuxRuntimeEvidence[] {
  if (!sessionName) return []
  if (run('tmux', ['has-session', '-t', sessionName]).status !== 0) return []
  const paneOutput = run('tmux', ['list-panes', '-t', sessionName, '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_path}']).stdout
  const panes: TmuxPaneSnapshot[] = paneOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [session_name, pidRaw, current_path = ''] = line.split('\t')
      const pane_pid = Number.parseInt(pidRaw ?? '', 10)
      return session_name && Number.isInteger(pane_pid)
        ? { session_name, pane_pid, current_path: current_path || null }
        : null
    })
    .filter((pane): pane is TmuxPaneSnapshot => pane !== null)
  if (panes.length === 0) return []
  const processes = parseProcessList(run('ps', ['-axo', 'pid,ppid,command']).stdout)
  return panes.flatMap((pane) => observeTmuxRuntime(pane, processes)).map((obs) => ({
    session_name: obs.session_name,
    observed_agent_id: obs.observed_agent_id,
    expected_agent_id: obs.expected_agent_id,
    server_pid: obs.server_pid,
  }))
}

const agentId = arg('agent-id')
const expectedAgentId = arg('expected-agent-id') ?? agentId
const sessionName = arg('session')
const port = Number.parseInt(arg('port') ?? '', 10)
const command = arg('command') ?? ''
const launcherRoot = realpathIfExists(arg('launcher-root') ?? process.cwd())
const managedCheckoutRoot = realpathIfExists(
  arg('managed-checkout-root')
    ?? join(process.env.HOME ?? '', '.agent-comms/state-daemon/checkouts'),
)
const currentCheckoutPath = realpathIfExists(
  arg('current-checkout-path')
    ?? join(process.env.HOME ?? '', '.agent-comms/state-daemon/current'),
)
const approvedLauncherRoots = splitList(arg('approved-root') ?? process.env.AGENT_COMMS_APPROVED_RESTART_ROOTS ?? '')
  .map(realpathIfExists)
  .filter((root): root is string => root !== null)
const codexPostStartEnterPolicy = (arg('codex-post-start-enter-policy') ?? 'update_prompt_only') as CodexPostStartEnterPolicy

const report = evaluateStartupSafety({
  agentId,
  expectedAgentId,
  sessionName,
  port: Number.isInteger(port) ? port : null,
  command,
  launcherRoot,
  managedCheckoutRoot,
  currentCheckoutPath,
  approvedLauncherRoots,
  portListeners: collectPortListeners(Number.isInteger(port) ? port : null),
  tmuxRuntimeEvidence: collectTmuxEvidence(sessionName),
  codexPostStartEnterPolicy,
})

if (report.ok) {
  const warningCodes = report.warnings.map((warning) => warning.code).join(',') || 'none'
  process.stderr.write(`[startup-safety] PASS agent=${report.agent_id ?? 'unknown'} session=${report.session_name ?? 'none'} port=${report.port ?? 'none'} warnings=${warningCodes}\n`)
  process.exit(0)
}

process.stderr.write(`[startup-safety] FAIL agent=${report.agent_id ?? 'unknown'} session=${report.session_name ?? 'none'} port=${report.port ?? 'none'}\n`)
for (const blocker of report.blockers) {
  process.stderr.write(`[startup-safety] blocker=${blocker.code} detail=${blocker.detail}\n`)
}
process.exit(2)
