/**
 * `aun start` — spawn claude with the aun launch flags (spec v6 v1.2 §1.4.2).
 *
 * Cycle 3 redesign: claude CLI flags live HERE, not in settings.json
 * mcpServers.args. The wrapper:
 *
 *   1. Resolves the claude binary (override via AUN_CLAUDE_BIN).
 *   2. Spawns it with stdio inherited from this process.
 *   3. Forwards SIGINT / SIGTERM to the child.
 *   4. Exits with the child's exit code so script-level launchers
 *      (`scripts/run-bot.sh`) can rely on conventional shell semantics.
 *
 * Flag set (frozen, §1.4.2 verbatim — order matters because the
 * `server:aun` value must follow `--dangerously-load-development-channels`):
 *
 *   --mcp-config "${AUN_MCP_CONFIG:-$HOME/.claude.json}"
 *   --dangerously-skip-permissions
 *   --dangerously-load-development-channels server:aun
 *   ...userArgs (verbatim pass-through)
 *
 * Pre-flight CLI signature drift check (cycle 1 carry-over) runs
 * unless `checkSignatures: false`. Drift is informational; we never
 * block the launch.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureSignatures, loadBaseline, compareToBaseline } from './lib/cli-signature-verify'

export class StartSpawnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartSpawnError'
  }
}

export interface StartOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  /** Pass-through args appended verbatim to the claude invocation. */
  extraArgs?: string[]
  /** Run the pre-flight signature check (default true). */
  checkSignatures?: boolean
  /** Actually spawn claude (default true; tests set false to inspect
   *  the constructed argv without launching anything). */
  spawn?: boolean
}

export interface StartResult {
  ok: boolean
  /** The full argv that was (or would be) passed to spawn. argv[0] is
   *  the claude binary; argv[1..] are the flags + user pass-through.
   */
  argv: string[]
  driftWarnings: string[]
  spawned: boolean
  errors: string[]
  /** PID of the spawned child, when applicable. */
  childPid?: number
}

function homeFor(opts: StartOptions): string {
  return opts.home ?? opts.env?.HOME ?? homedir()
}

function resolveMcpConfig(opts: StartOptions): string {
  const env = opts.env ?? process.env
  const explicit = env.AUN_MCP_CONFIG
  if (explicit && explicit.trim() !== '') return explicit
  return join(homeFor(opts), '.claude.json')
}

function resolveClaudeBin(opts: StartOptions): string {
  const env = opts.env ?? process.env
  return env.AUN_CLAUDE_BIN || 'claude'
}

/**
 * Build the argv we would hand to `spawn`. Exported so the contract
 * test (`test_aun_start_spawn_argv`) can verify the flag set without
 * actually launching claude.
 */
export function buildStartArgv(opts: StartOptions = {}): string[] {
  const claudeBin = resolveClaudeBin(opts)
  const mcpConfig = resolveMcpConfig(opts)
  return [
    claudeBin,
    '--mcp-config', mcpConfig,
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels', 'server:aun',
    ...(opts.extraArgs ?? []),
  ]
}

export function start(opts: StartOptions = {}): StartResult {
  const errors: string[] = []
  const driftWarnings: string[] = []
  const aunHome = join(homeFor(opts), '.aun')
  const baselinePath = join(aunHome, 'cli-baselines.json')

  if (opts.checkSignatures !== false) {
    try {
      const baseline = loadBaseline(baselinePath)
      if (baseline) {
        const current = captureSignatures()
        const report = compareToBaseline(current, baseline)
        for (const d of report.drifted) {
          driftWarnings.push(`[cli-drift ${d.reason}] ${d.name}: ${d.diffSummary}`)
        }
      }
    } catch {
      // Best-effort; never blocks launch.
    }
  }

  const argv = buildStartArgv(opts)

  if (opts.spawn === false) {
    return { ok: true, argv, driftWarnings, spawned: false, errors }
  }

  let child
  try {
    child = spawn(argv[0], argv.slice(1), {
      stdio: 'inherit',
      env: opts.env ?? process.env,
    })
  } catch (err) {
    const e = new StartSpawnError(`failed to spawn ${argv[0]}: ${(err as Error).message}`)
    errors.push(e.message)
    return { ok: false, argv, driftWarnings, spawned: false, errors }
  }

  // Forward common termination signals so Ctrl-C in the parent shell
  // reaches the claude session. Ignore send failures — the child may
  // already have exited.
  const forward = (sig: NodeJS.Signals) => {
    try { child.kill(sig) } catch { /* child gone */ }
  }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))

  // Inherit the child's exit code so shell-level callers can branch on
  // a successful claude session vs an aborted one.
  child.on('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal) } catch { process.exit(1) }
      return
    }
    process.exit(code ?? 0)
  })

  return { ok: true, argv, driftWarnings, spawned: true, errors, childPid: child.pid }
}
