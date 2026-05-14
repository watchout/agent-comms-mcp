/**
 * Per-bot wake suppression (PR #338 v0.9 spec §1.5, sub-PR 4).
 *
 * Replaces the per-message dedup window with a per-bot one. After a wake fires
 * for a bot, no further wake is issued for that bot inside the suppression
 * window, regardless of how many other pending rows the bot has. The window
 * is owned by the bot, not by any individual message.
 *
 * SSOT SQL:
 *
 *   UPDATE agents
 *      SET last_wake_attempt_at = now
 *    WHERE agent_id = bot
 *      AND last_wake_attempt_at outside suppression window;
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
  PgDBClient,
} from './fakes'
import { cleanAll, makeAgentId, openClient, seedAgent } from './seed'

const SUPPRESS_SEC = 30

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

async function insertPending(agent: string, when: Date, count: number): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const ins = await pg.query(
      `INSERT INTO message_queue (agent_id, status, payload, created_at)
         VALUES ($1, 'pending', '{}', $2) RETURNING id`,
      [agent, when],
    )
    ids.push(Number((ins.rows as Array<{ id: number }>)[0].id))
  }
  return ids
}

function mkDaemon(clock: FakeClock, tmux: FakeTmux, metrics: FakeMetrics) {
  return new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    clock,
    metrics,
    alert: new FakeAlertSink(),
    config: {
      agentIdPrefix: 'sd-test-',
      wakeDuplicateSuppressSec: SUPPRESS_SEC,
    },
  })
}

describe('per-bot wake suppression (PR #338 sub-PR 4 §1.5)', () => {
  test('test 1: bot に 5 pending msg、wake 1 回のみ、suppression 内 4 つ skip', async () => {
    const agent = makeAgentId('per-bot-1')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'online',
    })

    const t0 = new Date('2026-05-12T00:00:00.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      const ids = await insertPending(agent, t0, 5)

      for (const id of ids) {
        await daemon.__testHandleEvent({
          op: 'INSERT',
          id,
          agent_id: agent,
          status: 'pending',
          claim_expires_at: null,
        })
      }

      // First event wakes; the next four hit per-bot suppression.
      expect(tmux.sentKeys.length).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'ok' })).toBe(1)

      // Every pending row for the bot must carry the wake timestamp (the
      // bot-wide UPDATE is what makes per-bot suppression observable on
      // the next dispatch).
      const stamps = await pg.query<{ last_wake_attempt_at: Date | null }>(
        `SELECT last_wake_attempt_at FROM message_queue WHERE agent_id=$1`,
        [agent],
      )
      expect(stamps.rows.length).toBe(5)
      for (const row of stamps.rows) {
        expect(row.last_wake_attempt_at).not.toBeNull()
      }
      const agentWake = await pg.query<{ last_wake_attempt_at: Date | null }>(
        `SELECT last_wake_attempt_at FROM agents WHERE agent_id=$1`,
        [agent],
      )
      expect(agentWake.rows[0].last_wake_attempt_at).not.toBeNull()
    } finally {
      await daemon.stop()
    }
  })

  test('test 1b: single pending が received に移っても agent-level suppression が効く', async () => {
    const agent = makeAgentId('per-bot-1b')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'online',
    })

    const t0 = new Date('2026-05-12T00:00:30.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      const [id1] = await insertPending(agent, t0, 1)
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: id1,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
      expect(tmux.sentKeys.length).toBe(1)

      await pg.query(`UPDATE message_queue SET status='received' WHERE id=$1`, [id1])
      clock.advance(1000)

      const [id2] = await insertPending(agent, clock.now(), 1)
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: id2,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(tmux.sentKeys.length).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'ok' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })).toBe(1)
    } finally {
      await daemon.stop()
    }
  })

  test('test 1c: concurrent INSERT events でも agent-level reservation が wake を 1 回に抑える', async () => {
    const agent = makeAgentId('per-bot-1c')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'online',
    })

    const t0 = new Date('2026-05-12T00:00:45.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    tmux.sendDelayMs = 20
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      const ids = await insertPending(agent, t0, 2)
      await Promise.all(ids.map((id) => daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })))

      expect(tmux.sentKeys.length).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'ok' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })).toBe(1)
    } finally {
      await daemon.stop()
    }
  })

  test('test 2: pending 0 (no row) → suppression irrelevant, wake fires when a row arrives', async () => {
    const agent = makeAgentId('per-bot-2')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'online',
    })

    const t0 = new Date('2026-05-12T00:01:00.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      // No prior wake history. The very first pending message wakes.
      const [id] = await insertPending(agent, t0, 1)
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
      expect(tmux.sentKeys.length).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'ok' })).toBe(1)
    } finally {
      await daemon.stop()
    }
  })

  test('test 3: window 経過後の wake 復帰', async () => {
    const agent = makeAgentId('per-bot-3')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'online',
    })

    const t0 = new Date('2026-05-12T00:02:00.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      const [id1] = await insertPending(agent, t0, 1)
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: id1,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
      expect(tmux.sentKeys.length).toBe(1)

      // Advance the clock past the suppression window, insert another pending
      // row, and verify wake fires a second time.
      clock.advance((SUPPRESS_SEC + 1) * 1000)
      const [id2] = await insertPending(agent, clock.now(), 1)
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: id2,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
      expect(tmux.sentKeys.length).toBe(2)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'ok' })).toBe(2)
    } finally {
      await daemon.stop()
    }
  })

  test('test 4: 複数 bot 並行、各 bot 独立に suppression 評価', async () => {
    const agentA = makeAgentId('per-bot-4a')
    const agentB = makeAgentId('per-bot-4b')
    for (const a of [agentA, agentB]) {
      await seedAgent(pg, {
        agent_id: a,
        runtime: 'TUI',
        tmux_session: `${a}-session`,
        status: 'online',
      })
    }

    const t0 = new Date('2026-05-12T00:03:00.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      // Three pending rows each for two bots. Each bot wakes exactly once
      // inside the suppression window; the two bots do not affect each other.
      const idsA = await insertPending(agentA, t0, 3)
      const idsB = await insertPending(agentB, t0, 3)

      for (const id of [...idsA, ...idsB]) {
        const agent = idsA.includes(id) ? agentA : agentB
        await daemon.__testHandleEvent({
          op: 'INSERT',
          id,
          agent_id: agent,
          status: 'pending',
          claim_expires_at: null,
        })
      }

      expect(tmux.sentKeys.length).toBe(2)
      const sessions = tmux.sentKeys.map(k => k.session).sort()
      expect(sessions).toEqual([`${agentA}-session`, `${agentB}-session`].sort())
    } finally {
      await daemon.stop()
    }
  })
})
