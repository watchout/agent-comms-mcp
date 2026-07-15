/**
 * State-daemon m2 fixtures: T8-T17, T19b, T20.
 *
 * (T19 `sig_runtime_wake_throws` was replaced by T19b
 * `non_tui_runtime_wake_silent_skip` per re-chain Bug 3 — see header
 * comment on the T19b describe block below. The numeric "T19" slot in
 * the spec is now permanently re-assigned to the silent-skip semantic.)
 *
 * Each test seeds a clean slate (`cleanAll`) and exercises one §4.3 transition
 * or §6.x dispatch path. The daemon is started/stopped per-test so cron and
 * heartbeat intervals never overlap test boundaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import { DEFAULT_CONFIG, type DBClient } from '../../../core/state-daemon/types'
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

function buildHarness(
  t0: Date,
  configOverride: Partial<typeof DEFAULT_CONFIG> = {},
  db: DBClient = new PgDBClient(pg),
): Harness {
  const clock = new FakeClock(t0)
  const tmux = new FakeTmux()
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const pgListen = new FakePgListen()
  const daemon = new StateDaemon({
    db,
    pgListen,
    tmux,
    clock,
    metrics,
    alert,
    config: { agentIdPrefix: 'sd-test-', ...configOverride },
  })
  return { daemon, clock, tmux, metrics, alert, pgListen }
}

class RenewBeforeReclaimDb implements DBClient {
  private readonly delegate: PgDBClient
  private renewed = false
  casAttempts = 0

  constructor(
    private readonly client: Client,
    private readonly queueId: number,
    private readonly renewedExpiry: Date,
    private readonly renewedAt: Date,
  ) {
    this.delegate = new PgDBClient(client)
  }

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes("SET status='pending'") && sql.includes('claim_expires_at <')) {
      this.casAttempts += 1
      if (!this.renewed) {
        this.renewed = true
        await this.client.query(
          `UPDATE message_queue
              SET claim_expires_at=$2,
                  last_heartbeat_at=$3
            WHERE id=$1`,
          [this.queueId, this.renewedExpiry, this.renewedAt],
        )
      }
    }
    return this.delegate.query<T>(sql, params)
  }
}

// ── T8 ────────────────────────────────────────────────────────────────────────
describe('T8 pending_stale_rewake', () => {
  test('cron sweep observes a stale TUI row without prompt injection or wake stamps', async () => {
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
      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      const r = await pg.query(`SELECT last_wake_attempt_at FROM message_queue WHERE id=$1`, [id])
      const ts = (r.rows as Array<{ last_wake_attempt_at: Date | null }>)[0].last_wake_attempt_at
      expect(ts).toBeNull()
      const agentWake = await pg.query(`SELECT last_wake_attempt_at FROM agents WHERE agent_id=$1`, [agent])
      const agentTs = (agentWake.rows as Array<{ last_wake_attempt_at: Date | null }>)[0].last_wake_attempt_at
      expect(agentTs).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T9 ────────────────────────────────────────────────────────────────────────
describe('T9 pending_stale_duplicate_suppress', () => {
  test('historical wake timestamp is observed but does not trigger prompt dedup', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t9')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      created_at: T0,
      last_wake_attempt_at: new Date(T0.getTime() + 12_000),
    })
    await pg.query(`UPDATE agents SET last_wake_attempt_at=$1 WHERE agent_id=$2`, [
      new Date(T0.getTime() + 12_000),
      agent,
    ])

    const h = buildHarness(new Date(T0.getTime() + 15_000))
    await h.daemon.start()
    try {
      await h.daemon.sweepStale()
      expect(h.tmux.sentKeys.length).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T10 ───────────────────────────────────────────────────────────────────────
describe('T10 received_expired_reclaim', () => {
  test('received row with claim_expires_at in past → status=pending + no TUI prompt + reclaimed metric', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t10')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
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
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      const r = await pg.query(`SELECT status, claimed_by, claimed_at, claim_expires_at FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; claimed_by: string | null; claimed_at: Date | null; claim_expires_at: Date | null }>)[0]
      expect(row.status).toBe('pending')
      expect(row.claimed_by).toBeNull()
      expect(row.claimed_at).toBeNull()
      expect(row.claim_expires_at).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })

  test('in_progress row with claim_expires_at in past → status=pending + no TUI prompt + reclaimed metric', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t10-in-progress')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'idle' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
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
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      const r = await pg.query(`SELECT status, claimed_by, claimed_at, claim_expires_at FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; claimed_by: string | null; claimed_at: Date | null; claim_expires_at: Date | null }>)[0]
      expect(row.status).toBe('pending')
      expect(row.claimed_by).toBeNull()
      expect(row.claimed_at).toBeNull()
      expect(row.claim_expires_at).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })

  test('PostgreSQL microsecond claim timestamps remain reclaimable at mutation time', async () => {
    const T0 = new Date('2026-05-08T00:00:02.000Z')
    const agent = makeAgentId('t10-microsecond-precision')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'idle' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
      created_at: new Date('2026-05-08T00:00:00.000Z'),
      claim_expires_at: new Date('2026-05-08T00:00:01.000Z'),
      claimed_by: agent,
      claimed_at: new Date('2026-05-08T00:00:00.000Z'),
    })
    await pg.query(
      `UPDATE message_queue
          SET claimed_at='2026-05-08T00:00:00.123456Z'::timestamptz,
              claim_expires_at='2026-05-08T00:00:01.654321Z'::timestamptz
        WHERE id=$1`,
      [id],
    )
    const before = await pg.query<{ claimed_at: string; claim_expires_at: string }>(
      `SELECT to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claimed_at,
              to_char(claim_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claim_expires_at
         FROM message_queue
        WHERE id=$1`,
      [id],
    )
    expect(before.rows[0]).toEqual({
      claimed_at: '2026-05-08T00:00:00.123456Z',
      claim_expires_at: '2026-05-08T00:00:01.654321Z',
    })
    const driverRead = await pg.query<{ claimed_at: Date; claim_expires_at: Date }>(
      `SELECT claimed_at, claim_expires_at FROM message_queue WHERE id=$1`,
      [id],
    )
    expect(driverRead.rows[0].claimed_at.toISOString()).toBe('2026-05-08T00:00:00.123Z')
    expect(driverRead.rows[0].claim_expires_at.toISOString()).toBe('2026-05-08T00:00:01.654Z')

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.reclaimed).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaim_race_skipped' })).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      const after = await pg.query<{
        status: string
        claimed_by: string | null
        claimed_at: Date | null
        claim_expires_at: Date | null
      }>(`SELECT status, claimed_by, claimed_at, claim_expires_at FROM message_queue WHERE id=$1`, [id])
      expect(after.rows[0]).toEqual({
        status: 'pending',
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
      })
    } finally {
      await h.daemon.stop()
    }
  })

  test('renewal after expiry scan wins the reclaim CAS and produces no wake', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t10-renew-before-reclaim')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'busy' })
    const claimedAt = new Date(T0.getTime() - 35_000)
    const observedExpiry = new Date(T0.getTime() - 5_000)
    const renewedExpiry = new Date(T0.getTime() + 900_000)
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
      created_at: new Date(T0.getTime() - 40_000),
      claim_expires_at: observedExpiry,
      claimed_by: agent,
      claimed_at: claimedAt,
    })
    const raceDb = new RenewBeforeReclaimDb(pg, id, renewedExpiry, T0)
    const h = buildHarness(T0, {}, raceDb)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.reclaimed).toBe(0)
      expect(raceDb.casAttempts).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaim_race_skipped' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      const r = await pg.query(
        `SELECT status, agent_id, claimed_by, claimed_at, claim_expires_at, last_heartbeat_at
           FROM message_queue WHERE id=$1`,
        [id],
      )
      const row = (r.rows as Array<{
        status: string
        agent_id: string
        claimed_by: string | null
        claimed_at: Date | null
        claim_expires_at: Date | null
        last_heartbeat_at: Date | null
      }>)[0]
      expect(row.status).toBe('in_progress')
      expect(row.agent_id).toBe(agent)
      expect(row.claimed_by).toBe(agent)
      expect(new Date(row.claimed_at!).getTime()).toBe(claimedAt.getTime())
      expect(new Date(row.claim_expires_at!).getTime()).toBe(renewedExpiry.getTime())
      expect(new Date(row.last_heartbeat_at!).getTime()).toBe(T0.getTime())
    } finally {
      await h.daemon.stop()
    }
  })

  test('expired received row without memory-ready evidence is not reclaimed or rewoken', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t10-memory-block')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    await pg.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id=$1`, [agent])
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      created_at: new Date(T0.getTime() - 40_000),
      claim_expires_at: new Date(T0.getTime() - 5_000),
      claimed_by: agent,
      claimed_at: new Date(T0.getTime() - 35_000),
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.reclaimed).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'memory_ready_blocked',
        action: 'reclaim_expired',
        reason: 'missing_evidence',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
      const r = await pg.query(`SELECT status, claimed_by, claimed_at, claim_expires_at FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; claimed_by: string | null; claimed_at: Date | null; claim_expires_at: Date | null }>)[0]
      expect(row.status).toBe('received')
      expect(row.claimed_by).toBe(agent)
      expect(row.claimed_at).toBeInstanceOf(Date)
      expect(row.claim_expires_at).toBeInstanceOf(Date)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T11 ───────────────────────────────────────────────────────────────────────
// v0.9: 'failed' status + 'failed_reason' column removed (sub-PR 1 #347).
// abandonReset path is no-op'd; abandonment tracking redesign deferred to
// Issue #349.
describe.skip('T11 abandon_recent_reset (deferred to Issue #349)', () => {
  test('failed/IMPLICIT_ABANDON within abandon window resets to pending', async () => {})
})

// ── T12 ───────────────────────────────────────────────────────────────────────
// v0.9: status='failed' + failed_reason='STALE_DISPATCH' permanent-failure
// path collapsed to no-op (sub-PR 7). Redesign deferred to Issue #349.
describe.skip('T12 max_attempts_failed_permanently (deferred to Issue #349)', () => {
  test('read row aged 6min → status=failed, failed_reason=STALE_DISPATCH, alert', async () => {})
})

describe('T12b stale dispatch observation semantics', () => {
  test('stale owned active row is left open for durable completion', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t12b')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      created_at: new Date(T0.getTime() - 10 * 60_000),
      claim_expires_at: new Date(T0.getTime() + 60_000),
      claimed_by: agent,
      claimed_at: new Date(T0.getTime() - 9 * 60_000),
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.permanentlyFailed).toBe(0)
      const r = await pg.query(
        `SELECT status, failed_reason, done_at, replied_with, replied_at,
                claimed_by, claimed_at, claim_expires_at
           FROM message_queue WHERE id=$1`,
        [id],
      )
      const row = (r.rows as Array<{
        status: string
        failed_reason: string | null
        done_at: Date | null
        replied_with: string | null
        replied_at: Date | null
        claimed_by: string | null
        claimed_at: Date | null
        claim_expires_at: Date | null
      }>)[0]
      expect(row.status).toBe('received')
      expect(row.failed_reason).toBeNull()
      expect(row.done_at).toBeNull()
      expect(row.replied_with).toBeNull()
      expect(row.replied_at).toBeNull()
      expect(row.claimed_by).toBe(agent)
      expect(row.claimed_at).not.toBeNull()
      expect(row.claim_expires_at).not.toBeNull()
      expect(h.alert.alerts).toEqual([])
    } finally {
      await h.daemon.stop()
    }
  })

  test('live received row is observed without process-start prompt or terminal close', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t12b-live')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      created_at: new Date(T0.getTime() - 60_000),
      claim_expires_at: new Date(T0.getTime() + 60_000),
      claimed_by: agent,
      claimed_at: new Date(T0.getTime() - 30_000),
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.reclaimed).toBe(0)
      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_state_actions_total', {
        action: 'legacy_tui_disabled',
        status: 'received',
        terminal: 'false',
      })).toBe(1)
      const row = (await pg.query(`SELECT status, claimed_by, replied_with, failed_reason, last_wake_attempt_at FROM message_queue WHERE id=$1`, [id]))
        .rows[0] as { status: string; claimed_by: string | null; replied_with: string | null; failed_reason: string | null; last_wake_attempt_at: Date | null }
      expect({
        status: row.status,
        claimed_by: row.claimed_by,
        replied_with: row.replied_with,
        failed_reason: row.failed_reason,
      }).toEqual({
        status: 'received',
        claimed_by: agent,
        replied_with: null,
        failed_reason: null,
      })
      expect(row.last_wake_attempt_at).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })

  test('in_progress row is observed without wake or terminal close', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t12b-in-progress')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
      created_at: new Date(T0.getTime() - 60_000),
      claim_expires_at: new Date(T0.getTime() + 60_000),
      claimed_by: agent,
      claimed_at: new Date(T0.getTime() - 30_000),
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.reclaimed).toBe(0)
      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys.length).toBe(0)
      expect(h.metrics.countInc('state_daemon_state_actions_total', {
        action: 'observe_in_progress',
        status: 'in_progress',
        terminal: 'false',
      })).toBe(1)
      const row = (await pg.query(`SELECT status, claimed_by, replied_with, failed_reason FROM message_queue WHERE id=$1`, [id]))
        .rows[0] as { status: string; claimed_by: string | null; replied_with: string | null; failed_reason: string | null }
      expect(row).toEqual({
        status: 'in_progress',
        claimed_by: agent,
        replied_with: null,
        failed_reason: null,
      })
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
  test('row that matches both pending-stale and received-expired runs received-expired only', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t15')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    // row is received AND claim_expires_at past → received-expired branch (priority).
    // It is also "old enough" but pending-stale only fetches status='pending',
    // so the priority guard within sweepStale's pending loop is what stops the
    // double-action — covered by `expired.some(...)` skip. We still emit one
    // reclaim metric and one disabled TUI wake observation; pending loop
    // does not act on this row.
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
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
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      const r = await pg.query(`SELECT status, claimed_by, claimed_at, claim_expires_at FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string; claimed_by: string | null; claimed_at: Date | null; claim_expires_at: Date | null }>)[0]
      expect(row.status).toBe('pending')
      expect(row.claimed_by).toBeNull()
      expect(row.claimed_at).toBeNull()
      expect(row.claim_expires_at).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T16 ───────────────────────────────────────────────────────────────────────
describe('T16 pg_notify_immediate_dispatch', () => {
  test('FakePgListen.emit observes TUI work without prompt injection and records lag', async () => {
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
      // wait for FakePgListen fire-and-forget handler
      await new Promise((r) => setTimeout(r, 100))
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      expect(h.metrics.observed('state_daemon_pg_notify_lag_ms').length).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('received UPDATE event is observed without process-start prompt injection', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t16-received')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      created_at: T0,
      last_wake_attempt_at: null,
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
      })
      expect(h.tmux.sentKeys).toEqual([])

      h.clock.advance(1000)
      await pg.query(
        `UPDATE message_queue
            SET status='received',
                claimed_by=$1,
                claimed_at=$2,
                claim_expires_at=$3
          WHERE id=$4`,
        [agent, h.clock.now(), new Date(h.clock.now().getTime() + 60_000), id],
      )
      await h.daemon.__testHandleEvent({
        op: 'UPDATE',
        id,
        agent_id: agent,
        status: 'received',
        claim_expires_at: new Date(h.clock.now().getTime() + 60_000).toISOString(),
      })

      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', {
        action: 'legacy_tui_disabled',
        status: 'received',
        terminal: 'false',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(2)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(2)
    } finally {
      await h.daemon.stop()
    }
  })

  test('pg_notify TUI path never requires a tmux prompt-submission capability', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t16-tmux-fail')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending', created_at: T0 })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      h.pgListen.emit(JSON.stringify({
        op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
      }))
      await new Promise((r) => setTimeout(r, 50))

      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tmux_error' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_pg_notify_errors_total')).toBe(0)
      expect(h.alert.alerts).toEqual([])
      expect(h.daemon.__status).toBe('running')
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
      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
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

// ── T19b ──────────────────────────────────────────────────────────────────────
// Re-chain (msg 250d01b0) replaces the old T19 (which expected throw +
// WAKE_FAILED + alert on non-TUI runtime) with a silent-skip contract.
// The CEO account on Discord is `runtime='discord'` — a human, not a bot —
// and the previous semantic corrupted the queue row + spammed alerts on
// every dispatch addressed to that agent. New semantic per R15 / F13:
// metric tick only, queue stays `pending` for the actual delivery path.
describe('T19b non_tui_runtime_wake_silent_skip', () => {
  test('non-TUI runtime → no throw, queue row pending, metric non_tui_skipped, no alert', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t19b-discord')
    await seedAgent(pg, { agent_id: agent, runtime: 'discord' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending', created_at: T0 })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      // Must NOT throw.
      await h.daemon.__testHandleEvent({
        op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
      })

      // Queue row remains pending — no corruption.
      const r = await pg.query(`SELECT status FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ status: string }>)[0]
      expect(row.status).toBe('pending')

      // Metric ticked exactly once.
      expect(
        h.metrics.countInc('state_daemon_wake_actions_total', { result: 'non_tui_skipped' }),
      ).toBe(1)
      // No tmux send — non-TUI never reaches sendKeys.
      expect(h.tmux.sentKeys.length).toBe(0)
      // Silent: no alerts emitted.
      expect(h.alert.alerts.length).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('T19b — repeated non-TUI dispatches all silent-skip without alert flood', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t19b-flood')
    await seedAgent(pg, { agent_id: agent, runtime: 'sig' })
    const ids: number[] = []
    for (let i = 0; i < 4; i++) {
      const id = await seedQueueRow(pg, {
        agent_id: agent, status: 'pending', created_at: T0,
      })
      ids.push(id)
    }

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      for (const id of ids) {
        await h.daemon.__testHandleEvent({
          op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
        })
      }
      // 4 dispatches, 4 metric ticks, 0 alerts.
      expect(
        h.metrics.countInc('state_daemon_wake_actions_total', { result: 'non_tui_skipped' }),
      ).toBe(4)
      expect(h.alert.alerts.length).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('T19b — 5-event threshold case: still no alert, no abnormal_activity metric (cycle 2 Axis 1)', async () => {
    // Cycle 2 fix (auditor Axis 1): the original T19b stopped at 4 events,
    // so the actual abnormal-activity threshold (default 5) was never
    // exercised on a non-TUI agent. Silent-skip semantic must hold AT
    // and ABOVE the threshold — 5 dispatches against `runtime='discord'`
    // should still produce zero alerts and zero abnormal_activity metric
    // ticks (recording is gated behind the TUI runtime check in
    // executeWake; non-TUI never enters the rolling window).
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t19b-5x')
    await seedAgent(pg, { agent_id: agent, runtime: 'discord' })
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedQueueRow(pg, { agent_id: agent, status: 'pending', created_at: T0 }),
      )
    }

    const h = buildHarness(T0, {
      abnormalActivityThreshold: 5, // default, but pin explicit for the assertion
    })
    await h.daemon.start()
    try {
      for (const id of ids) {
        await h.daemon.__testHandleEvent({
          op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
        })
      }
      // 5 silent-skips, 0 abnormal-activity metric ticks, 0 alerts. The
      // dispatch counter must NOT advance for non-TUI agents.
      expect(
        h.metrics.countInc('state_daemon_wake_actions_total', { result: 'non_tui_skipped' }),
      ).toBe(5)
      expect(
        h.metrics.countInc('state_daemon_abnormal_activity_total', {
          agent_id: agent, kind: 'dispatch',
        }),
      ).toBe(0)
      expect(h.alert.alerts.length).toBe(0)
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
