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
