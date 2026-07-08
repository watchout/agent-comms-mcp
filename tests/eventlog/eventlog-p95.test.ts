// EventLogCore/v1 — performance budget fixture (fail-closed on regression).
//
// The owner's 高速/効率 requirement made testable: p95 budgets are hard
// assertions, so a structural slowdown (lost index, O(n²) projection query)
// fails this suite instead of shipping. Budgets are intentionally several
// times looser than observed baseline to absorb CI noise while still
// catching order-of-magnitude regressions.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  receiveMessage,
  claimNextTurn,
  completeTurn,
  queueView,
  openTurnCount,
} from '../../core/eventlog'

const N = 300 // open turns under load

// Budgets (ms). Baseline on a dev laptop is well under half of these.
const ENQUEUE_P95_BUDGET_MS = 10
const CLAIM_P95_BUDGET_MS = 50
const QUEUE_VIEW_BUDGET_MS = 250
const FULL_CYCLE_BUDGET_MS = 60_000 // enqueue+claim+complete all N

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

describe('performance budgets', () => {
  test(`p95 enqueue→claim within budget at ${N} open turns`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventlog-p95-'))
    const db = new SqliteAdapter(join(dir, 'perf.db'))
    await ensureEventLogSchema(db)
    const cycleStart = performance.now()

    // enqueue N messages (some conversational, some independent)
    const enqueueSamples: number[] = []
    for (let i = 0; i < N; i++) {
      const t0 = performance.now()
      await receiveMessage(db, {
        messageId: `m${i}`,
        seatId: 'kodama',
        conversationId: i % 5 === 0 ? `conv-${i % 7}` : null,
      })
      enqueueSamples.push(performance.now() - t0)
    }
    expect(await openTurnCount(db)).toBe(N)

    // queue_view projection over the fully loaded log
    const v0 = performance.now()
    const rows = await queueView(db)
    const viewMs = performance.now() - v0
    expect(rows.length).toBe(N)

    // claim+complete the whole backlog, sampling claim latency
    const claimSamples: number[] = []
    for (;;) {
      const t0 = performance.now()
      const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
      if (!claimed) break
      claimSamples.push(performance.now() - t0)
      await completeTurn(db, {
        turnId: claimed.turn.turn_id,
        seatId: 'kodama',
        seatInstanceId: 'i1',
        claimEventId: claimed.claimEventId,
        outcome: 'no_reply',
        conversationId: claimed.turn.conversation_id,
      })
    }
    const cycleMs = performance.now() - cycleStart

    expect(claimSamples.length).toBe(N)
    expect(await openTurnCount(db)).toBe(0)

    const enqueueP95 = p95(enqueueSamples)
    const claimP95 = p95(claimSamples)
    console.log(
      `[eventlog-p95] enqueue p95=${enqueueP95.toFixed(2)}ms ` +
      `claim p95=${claimP95.toFixed(2)}ms queue_view=${viewMs.toFixed(2)}ms ` +
      `full cycle (${N} turns)=${cycleMs.toFixed(0)}ms`,
    )

    // fail-closed budgets
    expect(enqueueP95).toBeLessThan(ENQUEUE_P95_BUDGET_MS)
    expect(claimP95).toBeLessThan(CLAIM_P95_BUDGET_MS)
    expect(viewMs).toBeLessThan(QUEUE_VIEW_BUDGET_MS)
    expect(cycleMs).toBeLessThan(FULL_CYCLE_BUDGET_MS)

    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }, 120_000)
})
