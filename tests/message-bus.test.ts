#!/usr/bin/env bun
/**
 * spec §13.1 / §13.5.1 — MessageBus / UnixSignalBus behavioural tests.
 *
 * Covers:
 *   - signal() when the PID file exists → SIGUSR1 delivered
 *   - signal() when the PID file is missing → silent no-op (polling fallback)
 *   - signal() when the PID file has garbage → no-op (no throw)
 *   - waitForSignal() resolves true on SIGUSR1
 *   - waitForSignal() resolves false on timeout
 *   - close() clears resources without throw
 *
 * The tests exercise the real process (the one running bun:test) as both
 * sender and receiver; we write our own PID to a temp file and signal
 * ourselves. This keeps the test portable across PG / SQLite modes.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMessageBus,
  UnixSignalBus,
  pidFilePathFor,
  type MessageBus,
} from '../core/message-bus'

const CREATED_FILES: string[] = []

function trackedWrite(path: string, content: string): void {
  writeFileSync(path, content)
  CREATED_FILES.push(path)
}

afterEach(() => {
  while (CREATED_FILES.length > 0) {
    const p = CREATED_FILES.pop()!
    try { if (existsSync(p)) unlinkSync(p) } catch {}
  }
})

describe('spec §13.1 — MessageBus factory', () => {
  test('createMessageBus() returns a UnixSignalBus', () => {
    const bus = createMessageBus()
    expect(bus).toBeInstanceOf(UnixSignalBus)
  })
})

describe('spec §13.1 — UnixSignalBus.signal()', () => {
  test('delivers SIGUSR1 when the PID file exists and points at a live PID', async () => {
    const agentId = `test-signal-${process.pid}-${Date.now()}`
    trackedWrite(pidFilePathFor(agentId), String(process.pid))

    const bus = new UnixSignalBus()

    // Install a one-shot listener, then fire signal() and assert the
    // listener actually sees SIGUSR1 within a short window.
    const received = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000)
      process.once('SIGUSR1', () => {
        clearTimeout(timer)
        resolve(true)
      })
      bus.signal(`bot_${agentId}`).catch(() => {})
    })

    expect(received).toBe(true)
  })

  test('is a silent no-op when the PID file does not exist', async () => {
    const bus = new UnixSignalBus()
    const agentId = `test-missing-${process.pid}-${Date.now()}`

    // No PID file is written. signal() must not throw, so the polling
    // fallback takes over transparently.
    await expect(bus.signal(`bot_${agentId}`)).resolves.toBeUndefined()
  })

  test('is a silent no-op when the PID file contains garbage', async () => {
    const agentId = `test-garbage-${process.pid}-${Date.now()}`
    trackedWrite(pidFilePathFor(agentId), 'not-a-pid')

    const bus = new UnixSignalBus()
    await expect(bus.signal(`bot_${agentId}`)).resolves.toBeUndefined()
  })

  test('accepts a bare agent id (no bot_ prefix) as channel name', async () => {
    const agentId = `test-bare-${process.pid}-${Date.now()}`
    trackedWrite(pidFilePathFor(agentId), String(process.pid))

    const bus = new UnixSignalBus()
    const received = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000)
      process.once('SIGUSR1', () => {
        clearTimeout(timer)
        resolve(true)
      })
      bus.signal(agentId).catch(() => {})
    })
    expect(received).toBe(true)
  })
})

describe('spec §13.1 — UnixSignalBus.waitForSignal()', () => {
  test('resolves true when SIGUSR1 arrives before the timeout', async () => {
    const bus = new UnixSignalBus()
    const waitPromise = bus.waitForSignal(`bot_${process.pid}`, 2000)

    // Fire SIGUSR1 at ourselves after a short delay so the waiter sees it.
    setTimeout(() => {
      try { process.kill(process.pid, 'SIGUSR1') } catch {}
    }, 50)

    const result = await waitPromise
    expect(result).toBe(true)
  })

  test('resolves false when the timeout fires first', async () => {
    const bus = new UnixSignalBus()
    const start = Date.now()
    const result = await bus.waitForSignal(`bot_${process.pid}`, 100)
    const elapsed = Date.now() - start

    expect(result).toBe(false)
    // The timeout should have taken effect roughly within the requested
    // window; allow generous headroom for CI scheduling.
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('spec §13.1 — UnixSignalBus.close()', () => {
  test('resolves without throwing', async () => {
    const bus = new UnixSignalBus()
    await expect(bus.close()).resolves.toBeUndefined()
  })
})

describe('spec §13.1 — pidFilePathFor()', () => {
  test('resolves to /tmp/agent-com-<agentId>.pid', () => {
    expect(pidFilePathFor('demo')).toBe('/tmp/agent-com-demo.pid')
  })
})

describe('spec §5.3 / §13.5.1 — run-bot.sh lost-wake-up fix (source pin)', () => {
  // Source-pin for the cycle 2 BLOCKER fix. If any of these disappear,
  // the lost-wake-up window the auditor flagged in cycle 1 is likely
  // back (trap drops the signal while `next` is running; sleep then
  // blocks for the full polling interval even though a message is
  // already waiting).
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'run-bot.sh'),
    'utf-8',
  )

  test('trap sets SIGNAL_RECEIVED=1 on SIGUSR1 (flag-tracked)', () => {
    expect(script).toContain(`trap 'SIGNAL_RECEIVED=1' USR1`)
  })

  test('loop body checks SIGNAL_RECEIVED before entering the sleep', () => {
    // The `if [ "$SIGNAL_RECEIVED" = "1" ]` guard must appear before the
    // background sleep, so a signal that fired during `next` skips the
    // wait entirely.
    const signalGuardIdx = script.indexOf(`if [ "$SIGNAL_RECEIVED" = "1" ]`)
    const sleepIdx = script.indexOf(`sleep "$WAIT_SECONDS" &`)
    expect(signalGuardIdx).toBeGreaterThan(-1)
    expect(sleepIdx).toBeGreaterThan(signalGuardIdx)
  })

  test('uses background sleep + wait so SIGUSR1 can interrupt', () => {
    // A foreground `sleep` is not interrupted by trapped signals in bash;
    // the fix backgrounds the sleep and `wait`s on its PID so the trap
    // can fire during the wait and return early.
    expect(script).toContain('sleep "$WAIT_SECONDS" &')
    expect(script).toContain('wait "$SLEEP_PID"')
  })

  test('kills the pending sleep if wait was interrupted by SIGUSR1', () => {
    // When the wait returns because of a signal (not the natural
    // timeout), the sleep process is still alive and must be killed to
    // avoid leaking one sleep per interrupted iteration.
    expect(script).toContain('kill "$SLEEP_PID"')
  })
})

describe('spec §5.3 — run-bot.sh end-to-end flow (source pin)', () => {
  // Source-pin for the spec §5.3 end-to-end flow (PR #218): the runner
  // must invoke `next` → LLM → `send` in the same iteration. If any of
  // these hooks disappear the runner has regressed into a stdout-only
  // probe and no reply reaches the chat UI.
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'run-bot.sh'),
    'utf-8',
  )

  test('LLM_CMD env var defaults to `claude --print`', () => {
    expect(script).toContain('LLM_CMD="${LLM_CMD:-claude --print}"')
  })

  test('extracts content / reply_chain / message_id / from from the next JSON', () => {
    expect(script).toContain(`jq -r '.content // ""'`)
    expect(script).toContain(`jq -r '.reply_chain // "[]"'`)
    expect(script).toContain(`jq -r '.message_id // ""'`)
    expect(script).toContain(`jq -r '.from // ""'`)
  })

  test('pipes the context through $LLM_CMD (unquoted for multi-token commands)', () => {
    // `$LLM_CMD` must be unquoted so `claude --print` splits into argv
    // tokens; quoting would hand the whole string to execvp as argv[0].
    expect(script).toMatch(/echo -e "\$context"\s*\|\s*\$LLM_CMD/)
  })

  test('calls `agent-com send` with --reply-to + --mentions when the LLM produced output', () => {
    expect(script).toContain(`cli/index.ts" send`)
    expect(script).toContain('--content "$response"')
    expect(script).toContain('--reply-to "$message_id"')
    expect(script).toContain('--mentions "$from"')
  })

  test('skips send when the LLM response is empty (implicit skip per §4.1 step 1)', () => {
    // Spec §5.3 エラーハンドリング: "LLM 失敗: send を呼ばない。次の next
    // 呼出で暗黙 skip (§4.1 step 1)、新規コマンド不要"
    expect(script).toContain('if [ -n "$response" ]; then')
    expect(script).toContain('LLM failed, skipping')
  })
})
