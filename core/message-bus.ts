/**
 * MessageBus — primary message delivery signaling (spec §13.1 / §13.5.1).
 *
 * Implementation: `UnixSignalBus`. Cross-DB, LLM-agnostic. The inbound
 * handler calls `bus.signal(\`bot_${agentId}\`)` after committing a
 * message_queue row; a bot runner (scripts/run-bot.sh or equivalent)
 * waits on SIGUSR1 and then pulls via `next`.
 *
 * Delivery layering (spec §13.5.1):
 *   primary   — MessageBus signal (this module)
 *   secondary — MCP notification (PR #215, MCP client-dependent)
 *   fallback  — polling (waitForSignal timeout → next)
 *
 * Unix signal approach is portable across PG/SQLite and does not rely
 * on DB-vendor-specific mechanisms (pg_notify / LISTEN etc.). A missing
 * PID file (bot offline) or an ESRCH `kill` is a no-op and the polling
 * fallback handles recovery. A *stale* PID file is NOT silent: if the
 * kernel has recycled the PID to an unrelated process, `process.kill()`
 * will succeed and deliver SIGUSR1 to that process. The default action
 * of SIGUSR1 is `terminate`, so this is non-fatal for our system but
 * observable on the unrelated victim — callers should treat the PID
 * file lifecycle (write on startup, `rm` via EXIT trap) as the primary
 * defence, not signal-source validation.
 */
import { readFileSync } from 'node:fs'

export interface MessageBus {
  /**
   * Signal the bot subscribed to `channel` that a new message is waiting.
   * Non-fatal: a missing PID file (bot offline), an ESRCH `kill`, or a
   * permission error all no-op and the polling fallback covers recovery.
   * Caveat: a *stale* PID file (kernel has recycled the PID) will cause
   * `process.kill()` to deliver SIGUSR1 to an unrelated process — see
   * the module docstring for why we accept this in favour of PID-file
   * hygiene (write on startup, EXIT-trap remove).
   */
  signal(channel: string): Promise<void>

  /**
   * Wait until SIGUSR1 arrives, or until `timeoutMs` elapses.
   * Resolves `true` on signal, `false` on timeout.
   */
  waitForSignal(channel: string, timeoutMs: number): Promise<boolean>

  /** Release any resources (listeners, timers). */
  close(): Promise<void>
}

/** Parse the agent_id out of a bus channel name. */
function agentIdFromChannel(channel: string): string {
  return channel.startsWith('bot_') ? channel.slice(4) : channel
}

/** Resolve the PID file path for an agent. */
export function pidFilePathFor(agentId: string): string {
  return `/tmp/agent-com-${agentId}.pid`
}

/**
 * Unix signal-based MessageBus. Signaling reads the target bot's PID
 * file and sends SIGUSR1; waiting installs a one-shot SIGUSR1 listener
 * gated by a timeout.
 *
 * Channel naming convention: `bot_<agentId>` (1 agent = 1 PID file = 1
 * SIGUSR1 listener in the bot's process).
 *
 * Stale-PID honesty: if the file exists but the PID has been recycled
 * by the kernel to an unrelated process, `process.kill()` will succeed
 * and deliver SIGUSR1 to that victim. SIGUSR1's default disposition is
 * `terminate`, so the consequence is bounded but *not* silent. We rely
 * on PID-file lifecycle (write on startup, `rm` on EXIT trap) to keep
 * the file in sync with the owning process; validating signal source
 * in this module is explicitly out of scope.
 */
export class UnixSignalBus implements MessageBus {
  async signal(channel: string): Promise<void> {
    const agentId = agentIdFromChannel(channel)
    const pidFile = pidFilePathFor(agentId)
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
      if (!Number.isFinite(pid) || pid <= 0) return
      // See class docstring — a stale PID can deliver SIGUSR1 to an
      // unrelated process. Non-fatal for us, but documented honestly.
      process.kill(pid, 'SIGUSR1')
    } catch {
      // ENOENT (bot offline) / ESRCH (PID already reaped) / EPERM →
      // polling fallback handles recovery.
    }
  }

  async waitForSignal(_channel: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const onSignal = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        process.removeListener('SIGUSR1', onSignal)
        resolve(false)
      }, timeoutMs)
      process.once('SIGUSR1', onSignal)
    })
  }

  async close(): Promise<void> {
    // No long-lived listeners to tear down — waitForSignal installs one-shot
    // listeners that self-remove on signal or timeout.
  }
}

/** Factory — current impl is always UnixSignalBus. */
export function createMessageBus(): MessageBus {
  return new UnixSignalBus()
}
