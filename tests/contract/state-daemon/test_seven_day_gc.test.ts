/**
 * 7-day GC (PR #338 v0.9 sub-PR 5, spec §1.6 GC job).
 *
 *   pre:  `replied` rows with `replied_at < now() - 7 days` exist.
 *   post: those rows are DELETEd, all others left intact.
 *   invariants:
 *     - `failed` rows are NEVER garbage-collected (retention policy).
 *     - `pending` / `read` / non-replied rows are NEVER touched.
 *     - DELETE is batched (config.gcBatchLimit, default 1000).
 *     - env override via STATE_DAEMON_GC_AGE_DAYS / _INTERVAL_MS /
 *       _BATCH_LIMIT (sub-PR 2 cycle 2 precedent).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import {
  DEFAULT_CONFIG,
  loadGcOverridesFromEnv,
} from '../../../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
  PgDBClient,
} from './fakes'
import { cleanAll, makeAgentId, openClient, seedAgent } from './seed'

let pg: Client

beforeAll(async () => {
  pg = await openClient()
})

afterAll(async () => {
  if (pg) {
    await cleanAll(pg)
    await pg.end()
  }
})

beforeEach(async () => {
  await cleanAll(pg)
})

function mkDaemon(clock: FakeClock, metrics: FakeMetrics, configOverride: Partial<typeof DEFAULT_CONFIG> = {}) {
  return new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux: new FakeTmux(),
    clock,
    metrics,
    alert: new FakeAlertSink(),
    config: { agentIdPrefix: 'sd-test-', ...configOverride },
  })
}

async function insertRow(
  agent: string,
  status: string,
  createdAt: Date,
  repliedAt: Date | null,
): Promise<number> {
  const ins = await pg.query(
    `INSERT INTO message_queue (agent_id, status, payload, created_at, replied_at)
       VALUES ($1, $2, '{}', $3, $4) RETURNING id`,
    [agent, status, createdAt, repliedAt],
  )
  return Number((ins.rows as Array<{ id: number }>)[0].id)
}

describe('7-day GC (PR #338 sub-PR 5, spec §1.6)', () => {
  test('replied rows older than the GC age are deleted', async () => {
    const agent = makeAgentId('gc-1')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
    })

    const now = new Date() // The SQL cutoff uses Postgres `now()`, not the FakeClock,
    // so the test must build its row timestamps relative to wall-clock time.
    const ancient = new Date(now.getTime() - 10 * 86_400_000) // 10 days ago
    const idStale = await insertRow(agent, 'replied', ancient, ancient)
    const idFresh = await insertRow(agent, 'replied', now, now)

    const daemon = mkDaemon(new FakeClock(now), new FakeMetrics())
    const result = await daemon.gcRepliedRows()

    expect(result.deleted).toBe(1)
    const remaining = await pg.query<{ id: number }>(
      `SELECT id FROM message_queue WHERE agent_id=$1 ORDER BY id`,
      [agent],
    )
    expect(remaining.rows.map(r => Number(r.id))).toEqual([idFresh])
    expect(remaining.rows.map(r => Number(r.id))).not.toContain(idStale)
  })

  // v0.9: 'failed' status removed from the enum (sub-PR 1 #347). The
  // invariant "non-replied rows are never GC'd" is now covered by the
  // pending/received case below; abandonment-tracking redesign is
  // deferred to Issue #349.
  test.skip('failed rows are NEVER garbage-collected (deferred to Issue #349)', async () => {})

  test('non-replied active rows (pending / received) are never touched', async () => {
    const agent = makeAgentId('gc-3')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
    })

    const now = new Date() // The SQL cutoff uses Postgres `now()`, not the FakeClock,
    // so the test must build its row timestamps relative to wall-clock time.
    const ancient = new Date(now.getTime() - 30 * 86_400_000)
    const idPending = await insertRow(agent, 'pending', ancient, null)
    const idReceived = await insertRow(agent, 'received', ancient, null)

    const daemon = mkDaemon(new FakeClock(now), new FakeMetrics())
    const result = await daemon.gcRepliedRows()

    expect(result.deleted).toBe(0)
    const remaining = await pg.query<{ id: number; status: string }>(
      `SELECT id, status FROM message_queue WHERE agent_id=$1 ORDER BY id`,
      [agent],
    )
    expect(remaining.rows.map(r => Number(r.id)).sort()).toEqual([idPending, idReceived].sort())
  })

  test('replied rows with NULL replied_at are not eligible (defensive)', async () => {
    // A replied row that somehow lacks a replied_at timestamp must not be
    // GC'd — the cutoff predicate cannot be evaluated, so the safer choice
    // is to leave the row alone.
    const agent = makeAgentId('gc-4')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
    })

    const now = new Date() // The SQL cutoff uses Postgres `now()`, not the FakeClock,
    // so the test must build its row timestamps relative to wall-clock time.
    const ancient = new Date(now.getTime() - 30 * 86_400_000)
    const idNullReplied = await insertRow(agent, 'replied', ancient, null)

    const daemon = mkDaemon(new FakeClock(now), new FakeMetrics())
    const result = await daemon.gcRepliedRows()

    expect(result.deleted).toBe(0)
    const still = await pg.query(
      `SELECT id FROM message_queue WHERE id=$1`,
      [idNullReplied],
    )
    expect(still.rows.length).toBe(1)
  })

  test('GC honours batchLimit (deletes at most config.gcBatchLimit rows per call)', async () => {
    const agent = makeAgentId('gc-5')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
    })

    const now = new Date() // The SQL cutoff uses Postgres `now()`, not the FakeClock,
    // so the test must build its row timestamps relative to wall-clock time.
    const ancient = new Date(now.getTime() - 30 * 86_400_000)
    for (let i = 0; i < 5; i++) await insertRow(agent, 'replied', ancient, ancient)

    const metrics = new FakeMetrics()
    const daemon = mkDaemon(new FakeClock(now), metrics, { gcBatchLimit: 2 })
    const result = await daemon.gcRepliedRows()

    expect(result.deleted).toBe(2)
    const remainingCount = await pg.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM message_queue WHERE agent_id=$1`,
      [agent],
    )
    expect(Number(remainingCount.rows[0]!.c)).toBe(3)
    // Metric ticks: 1 run, 2 rows deleted.
    expect(metrics.countInc('state_daemon_gc_runs_total')).toBeGreaterThanOrEqual(1)
  })

  test('custom gcRepliedAfterSec narrows the cutoff window', async () => {
    const agent = makeAgentId('gc-6')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
    })

    const now = new Date() // The SQL cutoff uses Postgres `now()`, not the FakeClock,
    // so the test must build its row timestamps relative to wall-clock time.
    const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000)
    const idOld = await insertRow(agent, 'replied', twoHoursAgo, twoHoursAgo)

    // 1-hour cutoff (well under default 7 days) → the 2-hour-old row qualifies.
    const daemon = mkDaemon(new FakeClock(now), new FakeMetrics(), {
      gcRepliedAfterSec: 3600,
    })
    const result = await daemon.gcRepliedRows()

    expect(result.deleted).toBe(1)
    const still = await pg.query(
      `SELECT id FROM message_queue WHERE id=$1`,
      [idOld],
    )
    expect(still.rows.length).toBe(0)
  })
})

describe('loadGcOverridesFromEnv', () => {
  test('returns empty when no env vars are set', () => {
    expect(loadGcOverridesFromEnv({})).toEqual({})
  })

  test('valid env vars produce the matching overrides', () => {
    expect(
      loadGcOverridesFromEnv({
        STATE_DAEMON_GC_AGE_DAYS: '3',
        STATE_DAEMON_GC_INTERVAL_MS: '120000',
        STATE_DAEMON_GC_BATCH_LIMIT: '500',
      }),
    ).toEqual({
      gcRepliedAfterSec: 3 * 86_400,
      gcIntervalMs: 120_000,
      gcBatchLimit: 500,
    })
  })

  test('malformed / non-positive env vars are ignored per-field', () => {
    expect(
      loadGcOverridesFromEnv({
        STATE_DAEMON_GC_AGE_DAYS: 'NaN',
        STATE_DAEMON_GC_INTERVAL_MS: '0',
        STATE_DAEMON_GC_BATCH_LIMIT: '-5',
      }),
    ).toEqual({})
  })

  test('partial env still produces partial overrides (fallback per-field)', () => {
    const out = loadGcOverridesFromEnv({ STATE_DAEMON_GC_AGE_DAYS: '1' })
    expect(out.gcRepliedAfterSec).toBe(86_400)
    expect(out.gcIntervalMs).toBeUndefined()
    expect(out.gcBatchLimit).toBeUndefined()
  })

  test('end-to-end: env var → constructor → daemon.config reflects override (cycle 2)', () => {
    // Auditor cycle 1 BLOCK (msg `ab541187`): the helper was defined but
    // the constructor did not call it, leaving env overrides dead-wired.
    // This test pins the production assembly path: setenv → new
    // StateDaemon(...) → config carries the override.
    const prior = {
      STATE_DAEMON_GC_AGE_DAYS: process.env.STATE_DAEMON_GC_AGE_DAYS,
      STATE_DAEMON_GC_BATCH_LIMIT: process.env.STATE_DAEMON_GC_BATCH_LIMIT,
    }
    process.env.STATE_DAEMON_GC_AGE_DAYS = '2'
    process.env.STATE_DAEMON_GC_BATCH_LIMIT = '250'
    try {
      const daemon = new StateDaemon({
        db: new PgDBClient(pg),
        pgListen: new FakePgListen(),
        tmux: new FakeTmux(),
        clock: new FakeClock(new Date()),
        metrics: new FakeMetrics(),
        alert: new FakeAlertSink(),
        config: {}, // intentionally empty — let env be the source
      })
      // Reach into the daemon's config via the same accessor the
      // production code uses for the GC scheduler. There is no public
      // getter, so the test reads the snapshot through a type-checked
      // cast that mirrors what the daemon itself does at construction.
      const cfg = (daemon as unknown as { config: typeof DEFAULT_CONFIG }).config
      expect(cfg.gcRepliedAfterSec).toBe(2 * 86_400)
      expect(cfg.gcBatchLimit).toBe(250)
      // The interval var was not set; the default must survive.
      expect(cfg.gcIntervalMs).toBe(DEFAULT_CONFIG.gcIntervalMs)
    } finally {
      if (prior.STATE_DAEMON_GC_AGE_DAYS === undefined) delete process.env.STATE_DAEMON_GC_AGE_DAYS
      else process.env.STATE_DAEMON_GC_AGE_DAYS = prior.STATE_DAEMON_GC_AGE_DAYS
      if (prior.STATE_DAEMON_GC_BATCH_LIMIT === undefined) delete process.env.STATE_DAEMON_GC_BATCH_LIMIT
      else process.env.STATE_DAEMON_GC_BATCH_LIMIT = prior.STATE_DAEMON_GC_BATCH_LIMIT
    }
  })

  test('end-to-end: explicit deps.config wins over env override (highest precedence)', () => {
    const prior = process.env.STATE_DAEMON_GC_AGE_DAYS
    process.env.STATE_DAEMON_GC_AGE_DAYS = '2'
    try {
      const daemon = new StateDaemon({
        db: new PgDBClient(pg),
        pgListen: new FakePgListen(),
        tmux: new FakeTmux(),
        clock: new FakeClock(new Date()),
        metrics: new FakeMetrics(),
        alert: new FakeAlertSink(),
        config: { gcRepliedAfterSec: 999 }, // caller / test wins
      })
      const cfg = (daemon as unknown as { config: typeof DEFAULT_CONFIG }).config
      expect(cfg.gcRepliedAfterSec).toBe(999)
    } finally {
      if (prior === undefined) delete process.env.STATE_DAEMON_GC_AGE_DAYS
      else process.env.STATE_DAEMON_GC_AGE_DAYS = prior
    }
  })
})
