/**
 * State-daemon m2 fixtures: T8-T17, T19, T20.
 *
 * Each test seeds a clean slate (`cleanAll`) and exercises one §4.3 transition
 * or §6.x dispatch path. The daemon is started/stopped per-test so cron and
 * heartbeat intervals never overlap test boundaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import { DEFAULT_CONFIG } from '../../../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
  PgDBClient,
} from './fakes'
import { cleanAll, makeAgentId, openClient, seedAgent, seedQueueRow } from './seed'

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

interface Harness {
  daemon: StateDaemon
  clock: FakeClock
  tmux: FakeTmux
  metrics: FakeMetrics
  alert: FakeAlertSink
  pgListen: FakePgListen
}

function buildHarness(t0: Date, configOverride: Partial<typeof DEFAULT_CONFIG> = {}): Harness {
  const clock = new FakeClock(t0)
  const tmux = new FakeTmux()
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const pgListen = new FakePgListen()
  const daemon = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen,
    tmux,
    clock,
    metrics,
    alert,
    config: { agentIdPrefix: 'sd-test-', ...configOverride },
  })
  return { daemon, clock, tmux, metrics, alert, pgListen }
}

// ── T8 ────────────────────────────────────────────────────────────────────────
describe('T8 pending_stale_rewake', () => {
  test('cron sweep at T0+15s wakes a row inserted at T0 with no last_wake_attempt_at', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t8')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      created_at: T0,
      last_wake_attempt_at: null,
    })

    const h = buildHarness(new Date(T0.getTime() + 15_000))
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.rewoken).toBe(1)
      expect(h.tmux.sentKeys.length).toBe(1)
      const r = await pg.query(`SELECT last_wake_attempt_at FROM message_queue WHERE id=$1`, [id])
      const ts = (r.rows as Array<{ last_wake_attempt_at: Date | null }>)[0].last_wake_attempt_at
      expect(ts).not.toBeNull()
      expect(Math.abs(new Date(ts!).getTime() - (T0.getTime() + 15_000))).toBeLessThan(1500)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T9 ────────────────────────────────────────────────────────────────────────
describe('T9 pending_stale_duplicate_suppress', () => {
  test('row woken 3s ago is dedup_skipped, no tmux send', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t9')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      created_at: T0,
      last_wake_attempt_at: new Date(T0.getTime() + 12_000),
    })

    const h = buildHarness(new Date(T0.getTime() + 15_000))
    await h.daemon.start()
    try {
      await h.daemon.sweepStale()
      expect(h.tmux.sentKeys.length).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T10 ───────────────────────────────────────────────────────────────────────
describe('T10 read_expired_reclaim', () => {
  test('read row with claim_expires_at in past → status=pending + sendKeys + reclaimed metric', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t10')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'read',
      created_at: new Date(T0.getTime() - 40_000),
      claim_expires_at: new Date(T0.getTime() - 5_000),
      claimed_by: agent,
      claimed_at: new Date(T0.getTime() - 35_000),
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.reclaimed).toBe(1)
      expect(h.tmux.sentKeys.length).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(1)
      const r = await pg.query(`SELECT status, claim_expires_at FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; claim_expires_at: Date | null }>)[0]
      expect(row.status).toBe('pending')
      expect(row.claim_expires_at).not.toBeNull()
      // New TTL must be > now (= T0)
      expect(new Date(row.claim_expires_at!).getTime()).toBeGreaterThan(T0.getTime())
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T11 ───────────────────────────────────────────────────────────────────────
describe('T11 abandon_recent_reset', () => {
  test('failed/IMPLICIT_ABANDON within abandon window resets to pending', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t11')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'failed',
      failed_reason: 'IMPLICIT_ABANDON',
      claim_expires_at: new Date(T0.getTime() - 30_000),
      created_at: new Date(T0.getTime() - 60_000),
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.abandonReset).toBe(1)
      const r = await pg.query(`SELECT status, failed_reason FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; failed_reason: string | null }>)[0]
      expect(row.status).toBe('pending')
      expect(row.failed_reason).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T12 ───────────────────────────────────────────────────────────────────────
describe('T12 max_attempts_failed_permanently', () => {
  test('read row aged 6min → status=failed, failed_reason=STALE_DISPATCH, alert', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t12')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'read',
      created_at: new Date(T0.getTime() - 6 * 60_000),
      claim_expires_at: new Date(T0.getTime() + 60_000), // claim still live so reclaim path skips
      claimed_by: agent,
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.permanentlyFailed).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'permanently_failed' })).toBe(1)
      expect(h.alert.alerts.length).toBeGreaterThanOrEqual(1)
      expect(h.alert.contains('STALE_DISPATCH')).toBe(true)
      const r = await pg.query(`SELECT status, failed_reason FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; failed_reason: string | null }>)[0]
      expect(row.status).toBe('failed')
      expect(row.failed_reason).toBe('STALE_DISPATCH')
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T13 ───────────────────────────────────────────────────────────────────────
describe('T13 db_connection_retry', () => {
  test('5 consecutive query failures inc db_errors_total and trigger alert', async () => {
    // We bypass the real pg client by injecting a flaky DBClient stub.
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const clock = new FakeClock(T0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const alert = new FakeAlertSink()
    const pgListen = new FakePgListen()
    let calls = 0
    const flakyDb = {
      async query<T = any>(_sql: string, _params?: unknown[]) {
        calls++
        if (calls <= 5) throw new Error(`connection refused #${calls}`)
        return { rows: [] as T[], rowCount: 0 }
      },
    }
    const daemon = new StateDaemon({ db: flakyDb, pgListen, tmux, clock, metrics, alert })
    await daemon.start()
    try {
      // 5 failing sweeps → on the 5th, dbErrorStreak hits threshold and alerts.
      for (let i = 0; i < 5; i++) {
        try { await daemon.sweepStale() } catch { /* DBConnectionError swallowed */ }
      }
      expect(metrics.countInc('state_daemon_db_errors_total')).toBe(5)
      expect(alert.alerts.some((a) => /streak/i.test(a))).toBe(true)
    } finally {
      await daemon.stop()
    }
  })

  test('T13b — 2 consecutive failures, no alert (under threshold)', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const clock = new FakeClock(T0)
    const metrics = new FakeMetrics()
    const alert = new FakeAlertSink()
    let calls = 0
    const flakyDb = {
      async query<T = any>(_sql: string, _params?: unknown[]) {
        calls++
        if (calls <= 2) throw new Error('temp')
        return { rows: [] as T[], rowCount: 0 }
      },
    }
    const daemon = new StateDaemon({
      db: flakyDb,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock, metrics, alert,
    })
    await daemon.start()
    try {
      try { await daemon.sweepStale() } catch {}
      try { await daemon.sweepStale() } catch {}
      expect(metrics.countInc('state_daemon_db_errors_total')).toBe(2)
      expect(alert.alerts.length).toBe(0)
    } finally {
      await daemon.stop()
    }
  })
})

// ── T14 ───────────────────────────────────────────────────────────────────────
describe('T14 sweep_budget_warn', () => {
  test('sweep duration > budgetWarnMs sets budgetWarn=true on result', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const clock = new FakeClock(T0)
    let q = 0
    const slowDb = {
      async query<T = any>(_sql: string, _params?: unknown[]) {
        q++
        // simulate slow first query
        if (q === 1) await new Promise((r) => setTimeout(r, 250))
        return { rows: [] as T[], rowCount: 0 }
      },
    }
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: slowDb,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock,
      metrics,
      alert: new FakeAlertSink(),
      // Override clock advance: we let real wall-clock cover the slow query,
      // but the daemon measures via clock.now(). To test the warn flag we
      // advance the clock manually after the slow fetch by tweaking budget
      // detection: budgetWarnMs=10 so even a tiny gap trips it.
      config: { budgetWarnMs: 10 },
    })
    // Advance clock so durationMs reads positive
    await daemon.start()
    try {
      // Capture sweep result and inject clock advance during await:
      // Simpler: just sweep with budgetWarnMs=10 — but our measurement uses
      // FakeClock which doesn't advance unless we do. Force advance via a
      // wrapping hook: advance after the first DB query completes.
      const origQuery = slowDb.query
      slowDb.query = async function <T = any>(sql: string, params?: unknown[]) {
        const r = await origQuery.call(this, sql, params)
        clock.advance(50) // simulate work time
        return r
      } as any
      const result = await daemon.sweepStale()
      expect(result.budgetWarn).toBe(true)
      expect(result.durationMs).toBeGreaterThanOrEqual(10)
    } finally {
      await daemon.stop()
    }
  })
})

// ── T15 ───────────────────────────────────────────────────────────────────────
describe('T15 dual_state_priority_order', () => {
  test('row that matches both pending-stale and read-expired runs read-expired only', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t15')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    // row is read AND claim_expires_at past → read-expired branch (priority).
    // It is also "old enough" but pending-stale only fetches status='pending',
    // so the priority guard within sweepStale's pending loop is what stops the
    // double-action — covered by `expired.some(...)` skip. We still emit one
    // sendKeys (from reclaim's re-wake) and one reclaim metric; pending loop
    // does not act on this row.
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'read',
      created_at: new Date(T0.getTime() - 15_000),
      claim_expires_at: new Date(T0.getTime() - 5_000),
      claimed_by: agent,
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.reclaimed).toBe(1)
      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys.length).toBe(1)
      const r = await pg.query(`SELECT status FROM message_queue WHERE id=$1`, [id])
      expect((r.rows as Array<{ status: string }>)[0].status).toBe('pending')
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T16 ───────────────────────────────────────────────────────────────────────
describe('T16 pg_notify_immediate_dispatch', () => {
  test('FakePgListen.emit drives handleQueueEvent → sendKeys + lag observed', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t16')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending', created_at: T0 })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      h.pgListen.emit(JSON.stringify({
        op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
      }))
      // wait microtask for fire-and-forget
      await new Promise((r) => setTimeout(r, 50))
      expect(h.tmux.sentKeys.length).toBe(1)
      expect(h.metrics.observed('state_daemon_pg_notify_lag_ms').length).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T17 ───────────────────────────────────────────────────────────────────────
describe('T17 pg_notify_miss_cron_pickup', () => {
  test('row with no notify path eventually picked up by cron sweep at age=15s', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t17')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent, status: 'pending', created_at: T0, last_wake_attempt_at: null,
    })

    const h = buildHarness(new Date(T0.getTime() + 15_000))
    await h.daemon.start()
    try {
      // No pg_notify emit. cron sweep is the recovery path.
      const result = await h.daemon.sweepStale()
      expect(result.rewoken).toBe(1)
      expect(h.tmux.sentKeys.length).toBe(1)
      // pg_notify lag was NOT observed (no emit happened).
      expect(h.metrics.observed('state_daemon_pg_notify_lag_ms').length).toBe(0)
      // sweep duration WAS observed.
      expect(h.metrics.observed('state_daemon_sweep_duration_ms').length).toBe(1)
      const _ = id // (unused, kept for clarity / future blame)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T19 ───────────────────────────────────────────────────────────────────────
describe('T19 sig_runtime_wake_throws', () => {
  test('SIG runtime wake → throws + DB row=failed/WAKE_FAILED + alert', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t19-sig')
    await seedAgent(pg, { agent_id: agent, runtime: 'SIG' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending', created_at: T0 })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      let threw = false
      try {
        await h.daemon.__testHandleEvent({
          op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
        })
      } catch (e) {
        threw = true
        expect((e as Error).message).toMatch(/SIG mode 廃止済/)
      }
      expect(threw).toBe(true)
      const r = await pg.query(`SELECT status, failed_reason FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; failed_reason: string | null }>)[0]
      expect(row.status).toBe('failed')
      expect(row.failed_reason).toBe('WAKE_FAILED')
      expect(h.alert.contains('SIG mode wake attempt blocked')).toBe(true)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T20 ───────────────────────────────────────────────────────────────────────
describe('T20 wake_pool_concurrency_limit', () => {
  test('pool with capacity=2 + 4 concurrent → 2 active, 2 queued', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const h = buildHarness(T0, {
      wakePoolMinCapacity: 2,
      wakePoolMaxCapacity: 2, // pin capacity
      wakePoolQueueHighWatermark: 100, // disable grow path
    })
    // Drive the pool directly via __wakePool — we don't need a real bot here.
    let release: () => void = () => {}
    const blocker = new Promise<void>((r) => { release = r })
    const job = { exec: async () => { await blocker } }

    // Fire 4 jobs without awaiting them.
    const promises = Array.from({ length: 4 }, () => h.daemon.__wakePool.run(job))
    // Yield so the pool can pick them up.
    await new Promise((r) => setTimeout(r, 10))
    expect(h.daemon.inspectWakePool().active).toBe(2)
    expect(h.daemon.inspectWakePool().queued).toBe(2)

    release()
    await Promise.all(promises)
    expect(h.daemon.inspectWakePool().active).toBe(0)
  })
})
