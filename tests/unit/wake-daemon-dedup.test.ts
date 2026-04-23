import { describe, test, expect, beforeEach } from 'bun:test'

// PR #0 §4.1 unit test: sliding-window de-dup boundary behaviour.
// Capacity exported by the daemon module is DEDUP_WINDOW=512 (§5 choice,
// meets the N≥100 instruction minimum). We import the internal helpers
// directly — no tmux / DB / subprocess involvement for this unit slice.
import { markSeen, dedupStats, __resetDedup } from '../../bin/wake-daemon'

beforeEach(() => {
  __resetDedup()
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
