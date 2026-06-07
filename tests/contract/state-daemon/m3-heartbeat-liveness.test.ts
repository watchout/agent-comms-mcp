/**
 * State-daemon m3 fixtures: T21-T26 (heartbeat / dead-bot restart / pool grow-shrink / TUI no-op observation).
 *
 * Covers the v0.3 reinforcement paths plus the disabled TUI wake observation
 * contract.
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

describe('T21 active claim heartbeat refresh', () => {
  test('busy bot with live in_progress claim → claim_expires_at extended', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t21-busy-in-progress')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'busy' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
      claim_expires_at: new Date(T0.getTime() + 30_000),
      claimed_by: agent,
      claimed_at: new Date(T0.getTime() - 10_000),
    })

    const h = buildHarness(T0, { claimTtlSec: 60 })
    await h.daemon.start()
    try {
      const result = await h.daemon.refreshClaims()
      expect(result.refreshed).toBe(1)
      expect(h.metrics.countInc('state_daemon_heartbeat_refresh_total', { result: 'ok' })).toBe(1)
      const r = await pg.query(
        `SELECT claim_expires_at, last_heartbeat_at FROM message_queue WHERE id=$1`,
        [id],
      )
      const row = (r.rows as Array<{ claim_expires_at: Date | null; last_heartbeat_at: Date | null }>)[0]
      expect(Math.abs(new Date(row.claim_expires_at!).getTime() - (T0.getTime() + 60_000))).toBeLessThan(1500)
      expect(Math.abs(new Date(row.last_heartbeat_at!).getTime() - T0.getTime())).toBeLessThan(1500)
      expect(h.tmux.sentKeys.length).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('busy bot with aged in_progress claim is not refreshed forever', async () => {
    const T0 = new Date('2026-05-08T00:05:00.000Z')
    const agent = makeAgentId('t21-aged-in-progress')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'busy' })
    const originalExpiry = new Date(T0.getTime() + 30_000)
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
      claim_expires_at: originalExpiry,
      claimed_by: agent,
      claimed_at: new Date(T0.getTime() - 301_000),
      last_heartbeat_at: new Date(T0.getTime() - 30_000),
    })

    const h = buildHarness(T0, { claimTtlSec: 60, activeClaimMaxAgeSec: 300 })
    await h.daemon.start()
    try {
      const result = await h.daemon.refreshClaims()
      expect(result.refreshed).toBe(0)
      expect(result.skipped).toBe(1)
      expect(h.metrics.countInc('state_daemon_heartbeat_refresh_total', { result: 'ok' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_heartbeat_refresh_total', { result: 'active_claim_max_age_skipped' })).toBe(1)
      const r = await pg.query(
        `SELECT claim_expires_at, last_heartbeat_at FROM message_queue WHERE id=$1`,
        [id],
      )
      const row = (r.rows as Array<{ claim_expires_at: Date | null; last_heartbeat_at: Date | null }>)[0]
      expect(new Date(row.claim_expires_at!).getTime()).toBe(originalExpiry.getTime())
      expect(Math.abs(new Date(row.last_heartbeat_at!).getTime() - (T0.getTime() - 30_000))).toBeLessThan(1500)
    } finally {
      await h.daemon.stop()
    }
  })

  test('claim with mismatched owner is not refreshed from agent status alone', async () => {
    const T0 = new Date('2026-05-08T00:07:00.000Z')
    const agent = makeAgentId('t21-owner-mismatch')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'busy' })
    const originalExpiry = new Date(T0.getTime() + 30_000)
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      claim_expires_at: originalExpiry,
      claimed_by: `${agent}-other`,
      claimed_at: new Date(T0.getTime() - 10_000),
    })

    const h = buildHarness(T0, { claimTtlSec: 60, activeClaimMaxAgeSec: 300 })
    await h.daemon.start()
    try {
      const result = await h.daemon.refreshClaims()
      expect(result.refreshed).toBe(0)
      expect(result.skipped).toBe(1)
      const r = await pg.query(`SELECT claim_expires_at, last_heartbeat_at FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ claim_expires_at: Date | null; last_heartbeat_at: Date | null }>)[0]
      expect(new Date(row.claim_expires_at!).getTime()).toBe(originalExpiry.getTime())
      expect(row.last_heartbeat_at).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })

  test('idle bot with live in_progress claim is not refreshed', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t21-idle-in-progress')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'idle' })
    const originalExpiry = new Date(T0.getTime() + 30_000)
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
      claim_expires_at: originalExpiry,
      claimed_by: agent,
    })

    const h = buildHarness(T0, { claimTtlSec: 60 })
    await h.daemon.start()
    try {
      const result = await h.daemon.refreshClaims()
      expect(result.refreshed).toBe(0)
      const r = await pg.query(`SELECT claim_expires_at, last_heartbeat_at FROM message_queue WHERE id=$1`, [id])
      const row = (r.rows as Array<{ claim_expires_at: Date | null; last_heartbeat_at: Date | null }>)[0]
      expect(new Date(row.claim_expires_at!).getTime()).toBe(originalExpiry.getTime())
      expect(row.last_heartbeat_at).toBeNull()
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T21 ───────────────────────────────────────────────────────────────────────
describe.skip('TODO #338 sub-PR 9 v0.9 schema T21 heartbeat_refresh_extends_claim', () => {
  test('online bot with live claim → claim_expires_at extended to now+claimTtl + last_heartbeat_at set', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t21-online')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'online' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      claim_expires_at: new Date(T0.getTime() + 30_000),
      claimed_by: agent,
    })

    const h = buildHarness(T0, { claimTtlSec: 60 })
    await h.daemon.start()
    try {
      const result = await h.daemon.refreshClaims()
      expect(result.refreshed).toBe(1)
      expect(h.metrics.countInc('state_daemon_heartbeat_refresh_total', { result: 'ok' })).toBe(1)
      const r = await pg.query(
        `SELECT claim_expires_at, last_heartbeat_at FROM message_queue WHERE id=$1`,
        [id],
      )
      const row = (r.rows as Array<{ claim_expires_at: Date | null; last_heartbeat_at: Date | null }>)[0]
      // claim_expires_at = T0 + 60s
      expect(Math.abs(new Date(row.claim_expires_at!).getTime() - (T0.getTime() + 60_000))).toBeLessThan(1500)
      // last_heartbeat_at ≈ T0
      expect(Math.abs(new Date(row.last_heartbeat_at!).getTime() - T0.getTime())).toBeLessThan(1500)
      // No tmux send (heartbeat is independent of wake).
      expect(h.tmux.sentKeys.length).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('T21b — already-expired claim is NOT refreshed (F7 self-reclaim path)', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t21-expired')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'online' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      claim_expires_at: new Date(T0.getTime() - 1000), // already past
      claimed_by: agent,
    })

    const h = buildHarness(T0, { claimTtlSec: 60 })
    await h.daemon.start()
    try {
      const result = await h.daemon.refreshClaims()
      expect(result.refreshed).toBe(0)
      const r = await pg.query(`SELECT claim_expires_at FROM message_queue WHERE id=$1`, [id])
      const ts = (r.rows as Array<{ claim_expires_at: Date | null }>)[0].claim_expires_at
      // Unchanged — still past T0.
      expect(new Date(ts!).getTime()).toBeLessThan(T0.getTime())
    } finally {
      await h.daemon.stop()
    }
  })

  test('T21c — offline bot is NOT refreshed', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t21-offline')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', status: 'offline' })
    await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      claim_expires_at: new Date(T0.getTime() + 30_000),
      claimed_by: agent,
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.refreshClaims()
      expect(result.refreshed).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T22 ───────────────────────────────────────────────────────────────────────
describe('T22 dead_bot_tmux_missing_restart', () => {
  test('TUI bot stale + tmux session absent → restart launcher + metric + alert', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t22-zombie')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-sess`,
      status: 'online',
      last_seen_at: new Date(T0.getTime() - 180_000), // stale
    })

    const h = buildHarness(T0)
    h.tmux.existingSessions = new Set() // empty = nothing exists
    await h.daemon.start()
    try {
      const result = await h.daemon.checkBotLiveness()
      expect(result.restarted).toBe(1)
      expect(h.tmux.restarts).toContain(agent)
      expect(h.metrics.countInc('state_daemon_bot_restarts_total', { agent_id: agent })).toBe(1)
      expect(h.alert.contains(`${agent} restarted`)).toBe(true)
      // status should have transitioned away from 'online'
      const r = await pg.query(`SELECT status FROM agents WHERE agent_id=$1`, [agent])
      expect((r.rows as Array<{ status: string }>)[0].status).not.toBe('online')
    } finally {
      await h.daemon.stop()
    }
  })

  test('T22b — TUI bot fresh last_seen_at: no restart', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t22-alive')
    await seedAgent(pg, {
      agent_id: agent, runtime: 'TUI', tmux_session: `${agent}-sess`, status: 'online',
      last_seen_at: new Date(T0.getTime() - 5000),
    })

    const h = buildHarness(T0)
    h.tmux.existingSessions = new Set() // even if no session, fresh last_seen_at ⇒ no restart
    await h.daemon.start()
    try {
      const result = await h.daemon.checkBotLiveness()
      expect(result.restarted).toBe(0)
      expect(h.tmux.restarts.length).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('Codex runtime stale last_seen_at: no restart or manual-intervention alert', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t22-codex-runner')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      status: 'idle',
      last_seen_at: new Date(T0.getTime() - 180_000),
    })

    const h = buildHarness(T0)
    await h.daemon.start()
    try {
      const result = await h.daemon.checkBotLiveness()
      expect(result.restarted).toBe(0)
      expect(result.escalated).toBe(0)
      expect(h.tmux.restarts.length).toBe(0)
      expect(h.alert.contains('manual intervention')).toBe(false)
      expect(h.metrics.countInc('state_daemon_bot_liveness_skipped_total', { runtime: 'codex' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T23 ───────────────────────────────────────────────────────────────────────
describe('T23 bot_restart_loop_limit_escalate', () => {
  test('bot already restarted N times in window → no further restart, escalate alert', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t23-flap')
    await seedAgent(pg, {
      agent_id: agent, runtime: 'TUI', tmux_session: `${agent}-sess`, status: 'online',
      last_seen_at: new Date(T0.getTime() - 180_000),
    })

    const h = buildHarness(T0, { botRestartMaxPerHour: 3 })
    h.tmux.existingSessions = new Set()
    await h.daemon.start()
    try {
      // Drive 3 restart attempts to exhaust the window. Each call advances the
      // clock minimally so timestamps differ but stay within the 1h window.
      for (let i = 0; i < 3; i++) {
        h.clock.advance(1000)
        await h.daemon.checkBotLiveness()
      }
      expect(h.tmux.restarts.length).toBe(3)
      // 4th call: already at limit → no restart, escalate alert.
      h.tmux.restarts.length = 0
      h.alert.reset()
      h.metrics.reset()
      h.clock.advance(1000)
      // Re-stale the bot so liveness re-fires
      await pg.query(`UPDATE agents SET last_seen_at=$1 WHERE agent_id=$2`, [
        new Date(h.clock.now().getTime() - 180_000), agent,
      ])
      const result = await h.daemon.checkBotLiveness()
      expect(result.restarted).toBe(0)
      expect(result.escalated).toBeGreaterThanOrEqual(1)
      expect(h.tmux.restarts.length).toBe(0)
      expect(h.metrics.countInc('state_daemon_bot_dead_total', { agent_id: agent })).toBe(1)
      expect(h.alert.contains('CEO escalate')).toBe(true)
    } finally {
      await h.daemon.stop()
    }
  })
})

// ── T24 ───────────────────────────────────────────────────────────────────────
describe('T24 wake_pool_grow_on_high_watermark', () => {
  test('queue depth > high watermark + capacity < MAX → capacity grows by step', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const h = buildHarness(T0, {
      wakePoolMinCapacity: 5,
      wakePoolMaxCapacity: 20,
      wakePoolGrowStep: 2,
      wakePoolQueueHighWatermark: 4, // small so we can trip easily
    })
    let release: () => void = () => {}
    const blocker = new Promise<void>((r) => { release = r })
    const job = { exec: async () => { await blocker } }

    // Fill capacity (5 active) + queue 5 more ⇒ queued > watermark on 5th queue.
    const promises: Promise<void>[] = []
    for (let i = 0; i < 10; i++) promises.push(h.daemon.__wakePool.run(job))
    await new Promise((r) => setTimeout(r, 30))

    const snap = h.daemon.inspectWakePool()
    expect(snap.active).toBe(7) // 5 initial + 2 grow step
    expect(snap.capacity).toBe(7)

    release()
    await Promise.all(promises)
  })

  test('T24b — capacity at MAX + queue overflow → saturated metric + alert (no grow)', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const h = buildHarness(T0, {
      wakePoolMinCapacity: 3,
      wakePoolMaxCapacity: 3,        // pin at MAX
      wakePoolGrowStep: 1,
      wakePoolQueueHighWatermark: 1,
    })
    let release: () => void = () => {}
    const blocker = new Promise<void>((r) => { release = r })
    const job = { exec: async () => { await blocker } }

    const promises: Promise<void>[] = []
    for (let i = 0; i < 6; i++) promises.push(h.daemon.__wakePool.run(job))
    await new Promise((r) => setTimeout(r, 30))

    expect(h.daemon.inspectWakePool().capacity).toBe(3) // pinned
    expect(h.metrics.countInc('state_daemon_wake_pool_saturated_total')).toBeGreaterThanOrEqual(1)
    expect(h.alert.contains('saturated')).toBe(true)

    release()
    await Promise.all(promises)
  })
})

// ── T25 ───────────────────────────────────────────────────────────────────────
describe('T25 wake_pool_shrink_on_idle', () => {
  test('queue empty + capacity > MIN → capacity shrinks by step on each completion', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const h = buildHarness(T0, {
      wakePoolMinCapacity: 2,
      wakePoolMaxCapacity: 8,
      wakePoolGrowStep: 2,
      wakePoolShrinkStep: 1,
      wakePoolQueueHighWatermark: 1,
    })
    // Force grow first by oversubscribing
    let release: () => void = () => {}
    const blocker = new Promise<void>((r) => { release = r })
    const job = { exec: async () => { await blocker } }
    const burst: Promise<void>[] = []
    for (let i = 0; i < 6; i++) burst.push(h.daemon.__wakePool.run(job))
    await new Promise((r) => setTimeout(r, 20))
    // capacity should have grown above MIN (likely to MAX)
    expect(h.daemon.inspectWakePool().capacity).toBeGreaterThan(2)
    release()
    await Promise.all(burst)
    // After all jobs drain, capacity should have shrunk back toward MIN.
    expect(h.daemon.inspectWakePool().capacity).toBe(2)
    expect(h.daemon.inspectWakePool().active).toBe(0)
  })
})

// ── T26 ───────────────────────────────────────────────────────────────────────
describe('T26 TUI prompt wake disabled at repeated-event threshold', () => {
  test('threshold-many TUI events remain typed observations without dispatch alerting', async () => {
    // Prompt wake dispatch is disabled, so repeated TUI queue observations must
    // not trip the historical dispatch-abnormality alert path.
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t26-chatty')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })

    const h = buildHarness(T0, {
      abnormalActivityWindowMs: 300_000,
      abnormalActivityThreshold: 5,
    })
    await h.daemon.start()
    try {
      for (let i = 0; i < 5; i++) {
        const ins = await pg.query(
          `INSERT INTO message_queue (agent_id, status, payload, created_at) VALUES ($1, 'pending', $3, $2) RETURNING id`,
          [agent, T0, JSON.stringify({ message_type: 'instruction', content: 'T26 fixture work' })],
        )
        const id = Number((ins.rows as Array<{ id: number }>)[0].id)
        await h.daemon.__testHandleEvent({
          op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
        })
        // Advance time to prove the disabled TUI path does not depend on the
        // historical wake suppression window.
        h.clock.advance(60_000)
      }
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(5)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_abnormal_activity_total', { agent_id: agent, kind: 'dispatch' })).toBe(0)
      expect(h.alert.contains('abnormal activity')).toBe(false)
    } finally {
      await h.daemon.stop()
    }
  })

  test('T26b — sub-threshold count: no metric inc, no alert', async () => {
    const T0 = new Date('2026-05-08T00:00:00.000Z')
    const agent = makeAgentId('t26-quiet')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI' })

    const h = buildHarness(T0, {
      abnormalActivityWindowMs: 300_000,
      abnormalActivityThreshold: 5,
    })
    await h.daemon.start()
    try {
      for (let i = 0; i < 4; i++) {
        const ins = await pg.query(
          `INSERT INTO message_queue (agent_id, status, payload, created_at) VALUES ($1, 'pending', $3, $2) RETURNING id`,
          [agent, T0, JSON.stringify({ message_type: 'instruction', content: 'T26 fixture work' })],
        )
        const id = Number((ins.rows as Array<{ id: number }>)[0].id)
        await h.daemon.__testHandleEvent({
          op: 'INSERT', id, agent_id: agent, status: 'pending', claim_expires_at: null,
        })
        h.clock.advance(1_000)
      }
      expect(h.metrics.countInc('state_daemon_abnormal_activity_total', { agent_id: agent, kind: 'dispatch' })).toBe(0)
      expect(h.alert.contains('abnormal activity')).toBe(false)
    } finally {
      await h.daemon.stop()
    }
  })
})
