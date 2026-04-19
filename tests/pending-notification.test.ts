#!/usr/bin/env bun
/**
 * spec §13.5.1 Pending Message Notification (MCP 標準) — behavioural tests.
 *
 * PollingDriver invokes the injected notifyPending callback with the
 * pending row count when the poll tick finds non-empty results. The
 * callback is non-fatal: failures must not break the poll loop, and
 * pending=0 ticks must not fire the callback.
 *
 * This file drives PollingDriver.poll() directly through the public
 * `start` + private poll timer path, using a stub DbLike so no real
 * Postgres is required.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PollingDriver, setDbGetter } from '../adapters/outbound-consumer'

type Row = { id: number; message_id: string | null; payload: string; priority: number; created_at: string }

function makeFakeDb(rows: Row[]) {
  const calls: Array<{ sql: string; params?: any[] }> = []
  return {
    calls,
    db: {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params })
        // Heartbeat UPDATE statements return no rows; only the SELECT
        // from message_queue returns fixture rows.
        if (/FROM message_queue/.test(sql)) {
          return { rows, rowCount: rows.length }
        }
        return { rows: [] as Row[], rowCount: 0 }
      },
    },
  }
}

function makeRow(id: number): Row {
  return {
    id,
    message_id: `msg-${id}`,
    payload: JSON.stringify({ author_id: 'cto', content: `test ${id}` }),
    priority: 0,
    created_at: new Date().toISOString(),
  }
}

describe('spec §13.5.1 — PollingDriver pending notification', () => {
  let driver: PollingDriver

  beforeEach(() => {
    driver = new PollingDriver()
  })

  afterEach(() => {
    driver.stop()
  })

  test('notifies with waiting count when pending rows exist', async () => {
    const { db } = makeFakeDb([makeRow(1), makeRow(2), makeRow(3)])
    setDbGetter(async () => db, 'test-agent-pending')

    const received: number[] = []
    driver.start('test-agent-pending', {
      notifyPending: (count) => { received.push(count) },
    })

    // Drive poll() directly via the private method — setInterval timing
    // is not observable in a sync test. PollingDriver.poll is invoked
    // via the setInterval callback at POLL_DRIVER_INTERVAL_MS; we bypass
    // timing to keep the test deterministic.
    await (driver as unknown as { poll(id: string): Promise<void> }).poll('test-agent-pending')

    expect(received).toEqual([3])
    expect(driver.buffered).toBe(3)
  })

  test('does not notify when pending is empty', async () => {
    const { db } = makeFakeDb([])
    setDbGetter(async () => db, 'test-agent-empty')

    const received: number[] = []
    driver.start('test-agent-empty', {
      notifyPending: (count) => { received.push(count) },
    })

    await (driver as unknown as { poll(id: string): Promise<void> }).poll('test-agent-empty')

    expect(received).toEqual([])
    expect(driver.buffered).toBe(0)
  })

  test('polling continues when notifyPending throws (non-fatal)', async () => {
    const { db } = makeFakeDb([makeRow(10)])
    setDbGetter(async () => db, 'test-agent-throw')

    driver.start('test-agent-throw', {
      notifyPending: () => { throw new Error('transport down') },
    })

    // poll() must complete without bubbling the callback error. If the
    // throw propagates, this await rejects and the test fails.
    await (driver as unknown as { poll(id: string): Promise<void> }).poll('test-agent-throw')

    // Buffer was populated before the callback ran, so the pull path
    // (next tool) is unaffected by the notification failure.
    expect(driver.buffered).toBe(1)
  })

  test('poll() returns immediately when notifyPending hangs (fire-and-forget)', async () => {
    // cycle 2 (auditor finding): hung callbacks must not pin polling=true
    // across ticks. notifyPending is dispatched fire-and-forget so poll()
    // resolves without waiting for the callback to settle.
    const { db } = makeFakeDb([makeRow(40)])
    setDbGetter(async () => db, 'test-agent-hang')

    // Callback that never resolves — simulates a stuck MCP transport.
    const neverResolves = new Promise<void>(() => {})
    let callbackInvoked = false
    driver.start('test-agent-hang', {
      notifyPending: () => {
        callbackInvoked = true
        return neverResolves
      },
    })

    // Must complete within a tight budget. If poll() were awaiting the
    // callback this would exceed 100ms easily (the callback is infinite).
    const start = Date.now()
    await (driver as unknown as { poll(id: string): Promise<void> }).poll('test-agent-hang')
    const elapsed = Date.now() - start

    expect(callbackInvoked).toBe(true)
    expect(elapsed).toBeLessThan(100)
    expect(driver.buffered).toBe(1)
  })

  test('does not attach notifyPending when callback is omitted', async () => {
    const { db } = makeFakeDb([makeRow(20), makeRow(21)])
    setDbGetter(async () => db, 'test-agent-no-cb')

    driver.start('test-agent-no-cb')

    // Should not throw even though no callback is supplied; buffer still
    // fills so `next` works. This preserves backwards compatibility for
    // callers that do not pass the new options argument.
    await (driver as unknown as { poll(id: string): Promise<void> }).poll('test-agent-no-cb')
    expect(driver.buffered).toBe(2)
  })

  test('stop() clears the notifyPending reference', async () => {
    const { db } = makeFakeDb([makeRow(30)])
    setDbGetter(async () => db, 'test-agent-stop')

    let callCount = 0
    driver.start('test-agent-stop', {
      notifyPending: () => { callCount++ },
    })
    driver.stop()

    // After stop() the callback is detached. A poll run after stop does
    // not happen via setInterval, but calling poll() directly must not
    // re-invoke the cleared callback.
    await (driver as unknown as { poll(id: string): Promise<void> }).poll('test-agent-stop')
    expect(callCount).toBe(0)
  })
})

describe('spec §13.5.1 — source-pin', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const REPO_ROOT = join(import.meta.dir, '..')

  test('PollingDriver.poll sends notifications/message/pending via callback branch', () => {
    const src = readFileSync(join(REPO_ROOT, 'adapters', 'outbound-consumer.ts'), 'utf-8')
    // The callback plumbing — option field, assignment in start(),
    // invocation in poll() guarded by rows.length > 0.
    expect(src).toMatch(/notifyPending\??\s*:\s*NotifyPendingFn/)
    expect(src).toMatch(/this\.notifyPending\s*=\s*opts\.notifyPending/)
    expect(src).toMatch(/if\s*\(\s*this\.notifyPending\s*&&\s*r\.rows\.length\s*>\s*0\s*\)/)
  })

  test('PollingDriver.poll dispatches notifyPending fire-and-forget (no await)', () => {
    // cycle 2 (auditor finding): the callback invocation must not be
    // awaited. Pin the Promise.resolve().then(...).catch() pattern at
    // source level so a future refactor cannot silently re-await.
    const src = readFileSync(join(REPO_ROOT, 'adapters', 'outbound-consumer.ts'), 'utf-8')
    const classIdx = src.indexOf('class PollingDriver')
    const classEnd = src.indexOf('\nexport const pollingDriver', classIdx)
    const body = src.slice(classIdx, classEnd === -1 ? undefined : classEnd)
    expect(body).toMatch(/Promise\.resolve\(\)\.then\(\s*\(\)\s*=>\s*cb\(/)
    expect(body).not.toMatch(/await\s+this\.notifyPending\(/)
  })

  test('server.ts wires mcp.notification with notifications/message/pending method', () => {
    const src = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
    expect(src).toMatch(/pollingDriver\.start\(\s*AGENT_ID\s*,\s*\{/)
    expect(src).toMatch(/notifications\/message\/pending/)
    expect(src).toMatch(/notifyPending\s*:\s*\(\s*waiting\s*\)\s*=>/)
  })
})
