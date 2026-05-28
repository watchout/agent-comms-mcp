import { describe, test, expect, beforeEach } from 'bun:test'
import { randomUUID } from 'node:crypto'

// PR #0 §4.1 unit test: sliding-window de-dup boundary behaviour.
// Capacity exported by the daemon module is DEDUP_WINDOW=512 (§5 choice,
// meets the N≥100 instruction minimum). We import the internal helpers
// directly — no tmux / DB / subprocess involvement for this unit slice.
import {
  markSeen,
  dedupStats,
  __resetDedup,
  shouldWake,
  wakeDedupStats,
  __resetWakeDedup,
  dispatchPgNotificationPayload,
} from '../../bin/wake-daemon'

beforeEach(() => {
  __resetDedup()
  __resetWakeDedup()
})

describe('wake-daemon sliding-window de-dup (§2.4, unit)', () => {
  test('first occurrence returns false, repeat returns true', () => {
    expect(markSeen('m1')).toBe(false)
    expect(markSeen('m1')).toBe(true)
    expect(markSeen('m1')).toBe(true)
    expect(dedupStats().size).toBe(1)
  })

  test('distinct ids each register once', () => {
    expect(markSeen('m1')).toBe(false)
    expect(markSeen('m2')).toBe(false)
    expect(markSeen('m3')).toBe(false)
    expect(markSeen('m2')).toBe(true)
    expect(dedupStats().size).toBe(3)
  })

  test('capacity advertises as ≥100 (instruction §2.4 floor)', () => {
    expect(dedupStats().capacity).toBeGreaterThanOrEqual(100)
  })

  test('boundary 100: fills to 100 without eviction', () => {
    for (let i = 0; i < 100; i++) {
      expect(markSeen(`m${i}`)).toBe(false)
    }
    expect(dedupStats().size).toBe(100)
    // Earliest id still remembered.
    expect(markSeen('m0')).toBe(true)
  })

  test('boundary 200: distinct ids up to 200 retained when capacity ≥ 200', () => {
    const cap = dedupStats().capacity
    const count = Math.min(200, cap)
    for (let i = 0; i < count; i++) {
      expect(markSeen(`m${i}`)).toBe(false)
    }
    expect(dedupStats().size).toBe(count)
    expect(markSeen('m0')).toBe(true)
    expect(markSeen(`m${count - 1}`)).toBe(true)
  })

  test('boundary 500: fills near capacity without false-positive duplicates', () => {
    const cap = dedupStats().capacity
    const count = Math.min(500, cap)
    for (let i = 0; i < count; i++) {
      expect(markSeen(`id-${i}`)).toBe(false)
    }
    expect(dedupStats().size).toBe(count)
    // Re-check a spread of ids — each must register as duplicate.
    for (const i of [0, 1, 50, 250, count - 1]) {
      expect(markSeen(`id-${i}`)).toBe(true)
    }
  })

  test('overflow past capacity evicts oldest first (FIFO sliding window)', () => {
    const cap = dedupStats().capacity
    // Fill capacity exactly.
    for (let i = 0; i < cap; i++) markSeen(`fill-${i}`)
    expect(dedupStats().size).toBe(cap)
    // One more insert should evict the oldest (fill-0).
    expect(markSeen('overflow-1')).toBe(false)
    expect(dedupStats().size).toBe(cap)
    // Oldest is gone — re-seeing it registers as new (false).
    expect(markSeen('fill-0')).toBe(false)
    // Recent entry (just-evicted+1) is still tracked.
    // After evicting fill-0 and adding overflow-1 then fill-0 again, the
    // queue head is fill-2 (fill-1 was evicted by the fill-0 re-add).
    expect(markSeen('fill-2')).toBe(true)
  })

  test('repeated duplicates do not advance the eviction cursor', () => {
    for (let i = 0; i < 10; i++) markSeen(`e${i}`)
    expect(dedupStats().size).toBe(10)
    // Hammer duplicates — size and order must not change.
    for (let k = 0; k < 50; k++) markSeen('e5')
    expect(dedupStats().size).toBe(10)
    expect(markSeen('e0')).toBe(true)
    expect(markSeen('e9')).toBe(true)
  })
})

// PR #233 v4 §77-1 — agent_id time-window de-dup (1 s) sits beside the
// per-message-id sliding window. These cases exercise only the time-based
// layer; the `now` parameter lets us pin the clock deterministically.
describe('wake-daemon agent_id time-window dedup (v4 §77-1, PR #233)', () => {
  test('first call for an agent returns true, repeat within window returns false', () => {
    expect(shouldWake('alice', 1000)).toBe(true)
    expect(shouldWake('alice', 1500)).toBe(false)
    expect(shouldWake('alice', 1999)).toBe(false)
  })

  test('distinct agents are tracked independently', () => {
    expect(shouldWake('alice', 1000)).toBe(true)
    expect(shouldWake('bob', 1000)).toBe(true)
    expect(shouldWake('alice', 1200)).toBe(false)
    expect(shouldWake('bob', 1200)).toBe(false)
    expect(wakeDedupStats().tracked).toBe(2)
  })

  test('window boundary: exactly 1000ms later reopens the gate (>= WAKE_DEDUP_MS)', () => {
    expect(shouldWake('alice', 5000)).toBe(true)
    // Boundary: now - last === WAKE_DEDUP_MS (1000). The predicate uses
    // strict less-than, so this moment is the first permitted re-wake.
    expect(shouldWake('alice', 6000)).toBe(true)
    // Within the new window again — blocked.
    expect(shouldWake('alice', 6500)).toBe(false)
  })

  test('window advertised as 1000 ms (v4 §77-1 contract)', () => {
    expect(wakeDedupStats().windowMs).toBe(1000)
  })

  test('stats expose the number of agents tracked and clear on reset', () => {
    shouldWake('a', 1000)
    shouldWake('b', 1000)
    shouldWake('c', 1000)
    expect(wakeDedupStats().tracked).toBe(3)
    __resetWakeDedup()
    expect(wakeDedupStats().tracked).toBe(0)
  })

  test('late arrivals long after the window act like a fresh wake', () => {
    expect(shouldWake('alice', 10_000)).toBe(true)
    // 5 seconds later — well past the 1 s window.
    expect(shouldWake('alice', 15_000)).toBe(true)
    expect(shouldWake('alice', 15_500)).toBe(false)
  })
})

describe('wake-daemon PG notification dispatch failure handling', () => {
  async function waitForLog(match: (value: string) => boolean, read: () => string): Promise<string | null> {
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      const current = read()
      if (match(current)) return current
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return null
  }

  test('profile resolver failure is logged without unhandled rejection', async () => {
    const originalWrite = process.stderr.write
    let stderr = ''
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
      return true
    }) as typeof process.stderr.write

    try {
      const payload = JSON.stringify({
        agent_id: `pg-dispatch-${randomUUID()}`,
        message_id: `msg-${randomUUID()}`,
      })
      dispatchPgNotificationPayload(payload, async () => {
        throw new Error('profile query boom')
      })
      const logged = await waitForLog(
        (value) => value.includes('parse/wake error') && value.includes('profile query boom'),
        () => stderr,
      )

      expect(logged).not.toBeNull()
      expect(unhandled).toEqual([])
    } finally {
      process.stderr.write = originalWrite
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
