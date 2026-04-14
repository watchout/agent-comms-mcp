/**
 * Pure bot-health check used by the MCP `bot_status` tool.
 *
 * Extracted from server.ts so all six branches can be unit-tested
 * with injected side-effect deps (tmux / lsof / ps).
 *
 * Post-PR#172 the stable signal of channel-plugin mode is a
 * `bun run .../server.ts` process listening on the agent's
 * WEBHOOK_PORT — the MCP plugin spawns it and holds the port.
 * The legacy flag-based check (for `--dangerously-load-development-
 * channels` in the tmux output) was a false-alarm source for all
 * 19 bots after PR #172 removed the flag from every launch path.
 */
export interface BotHealthEntry {
  session: string
  port: number
}

export interface BotHealthDeps {
  hasSession: (session: string) => boolean
  capture: (session: string, lines?: number) => string
  getPids: (port: number) => string[]
  /** Run `ps -p <pid> -o command=` and return stdout. */
  psCommand: (pid: string) => string
}

export interface BotHealthResult {
  status: 'dead' | 'crashed' | 'exited' | 'initializing' | 'misconfigured' | 'healthy'
  details: string
}

export function checkBotHealth(entry: BotHealthEntry, deps: BotHealthDeps): BotHealthResult {
  // Check 1: tmux session present.
  if (!deps.hasSession(entry.session)) {
    return { status: 'dead', details: 'tmux session not found' }
  }

  const output = deps.capture(entry.session, 30)

  // Check 2: crash patterns in the pane output.
  if (/panic|fatal|SIGKILL|segmentation fault|killed|out of memory/i.test(output)) {
    return { status: 'crashed', details: 'crash pattern detected' }
  }

  // Check 3: Claude Code exited to a bare shell prompt.
  const lastLine = output.split('\n').filter(l => l.trim()).pop() ?? ''
  if (/^\S+@\S+ .+ % $|^\$ $/.test(lastLine)) {
    return { status: 'exited', details: 'Claude Code exited to shell prompt' }
  }

  // Check 4: bun server.ts listening on the expected port.
  const pids = deps.getPids(entry.port)
  if (pids.length === 0) {
    return {
      status: 'initializing',
      details: `session exists, port ${entry.port} free (bun not yet listening)`,
    }
  }

  const portInfo = `port ${entry.port} in use (PID: ${pids.join(',')})`
  const pidIsBunServer = pids.some(pid => {
    try {
      return /bun.*server\.ts/.test(deps.psCommand(pid))
    } catch {
      return false
    }
  })

  if (!pidIsBunServer) {
    return {
      status: 'misconfigured',
      details: `${portInfo} but PID is not bun server.ts (port squatted by unrelated process)`,
    }
  }

  return { status: 'healthy', details: `bun server.ts listening + ${portInfo}` }
}
