/**
 * TUI wake prompt injection disabled.
 *
 * This supersedes the old per-bot wake suppression contract. TUI queue
 * work is still visible through typed planner/metric evidence, but the daemon
 * must not inject natural-language prompts or stamp wake-attempt state unless
 * an approved runner path is invoked.
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
import { cleanAll, makeAgentId, openClient, seedAgent, seedQueueRow } from './seed'

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
    ids.push(await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      created_at: when,
      payload: JSON.stringify({ message_type: 'instruction', content: 'TUI prompt-disabled fixture work' }),
    }))
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

describe('TUI prompt wake is disabled', () => {
  test('pending fanout records typed evidence without prompts or wake stamps', async () => {
    const agent = makeAgentId('tui-noop-fanout')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'idle',
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

      expect(tmux.sentKeys).toEqual([])
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(5)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })).toBe(0)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(5)
      expect(metrics.countInc('state_daemon_state_actions_total', {
        action: 'legacy_tui_disabled',
        status: 'pending',
        terminal: 'false',
      })).toBe(5)

      const stamps = await pg.query<{ last_wake_attempt_at: Date | null }>(
        `SELECT last_wake_attempt_at FROM message_queue WHERE agent_id=$1`,
        [agent],
      )
      expect(stamps.rows.length).toBe(5)
      for (const row of stamps.rows) {
        expect(row.last_wake_attempt_at).toBeNull()
      }
      const agentWake = await pg.query<{ last_wake_attempt_at: Date | null }>(
        `SELECT last_wake_attempt_at FROM agents WHERE agent_id=$1`,
        [agent],
      )
      expect(agentWake.rows[0].last_wake_attempt_at).toBeNull()
    } finally {
      await daemon.stop()
    }
  })

  test('historical wake timestamps do not drive prompt lifecycle or dedup', async () => {
    const agent = makeAgentId('tui-noop-history')
    const t0 = new Date('2026-05-12T00:00:30.000Z')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'idle',
      last_seen_at: t0,
    })
    await pg.query(`UPDATE agents SET last_wake_attempt_at=$1 WHERE agent_id=$2`, [
      new Date(t0.getTime() - 1000),
      agent,
    ])

    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      const [id] = await insertPending(agent, t0, 1)
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(tmux.sentKeys).toEqual([])
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })).toBe(0)
      const row = await pg.query<{ last_wake_attempt_at: Date | null }>(
        `SELECT last_wake_attempt_at FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(row.rows[0].last_wake_attempt_at).toBeNull()
    } finally {
      await daemon.stop()
    }
  })

  test('active claims are observed as busy without prompt injection', async () => {
    const agent = makeAgentId('tui-noop-busy')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'idle',
    })

    const t0 = new Date('2026-05-12T00:00:55.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      await seedQueueRow(pg, {
        agent_id: agent,
        status: 'received',
        payload: '{}',
        created_at: t0,
        claimed_by: agent,
        claimed_at: t0,
        claim_expires_at: new Date(t0.getTime() + 60_000),
      })
      const [id] = await insertPending(agent, t0, 1)
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(tmux.sentKeys).toEqual([])
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'active_claim_skipped' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
      expect(metrics.countInc('state_daemon_state_actions_total', {
        action: 'observe_busy',
        status: 'pending',
        terminal: 'false',
      })).toBe(1)
    } finally {
      await daemon.stop()
    }
  })

  test('received TUI rows are observed without process-start prompts', async () => {
    const agent = makeAgentId('tui-noop-received')
    const t0 = new Date('2026-05-12T00:01:00.000Z')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'idle',
    })
    const rowId = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      payload: '{}',
      created_at: t0,
      claimed_by: agent,
      claimed_at: t0,
      claim_expires_at: new Date(t0.getTime() + 60_000),
    })

    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'UPDATE',
        id: rowId,
        agent_id: agent,
        status: 'received',
        claim_expires_at: new Date(t0.getTime() + 60_000).toISOString(),
      })

      expect(tmux.sentKeys).toEqual([])
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      expect(metrics.countInc('state_daemon_state_actions_total', {
        action: 'legacy_tui_disabled',
        status: 'received',
        terminal: 'false',
      })).toBe(1)
    } finally {
      await daemon.stop()
    }
  })

  test('multiple bots produce independent typed observations, not tmux submissions', async () => {
    const agentA = makeAgentId('tui-noop-multi-a')
    const agentB = makeAgentId('tui-noop-multi-b')
    for (const a of [agentA, agentB]) {
      await seedAgent(pg, {
        agent_id: a,
        runtime: 'TUI',
        tmux_session: `${a}-session`,
        status: 'idle',
      })
    }

    const t0 = new Date('2026-05-12T00:03:00.000Z')
    const clock = new FakeClock(t0)
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const daemon = mkDaemon(clock, tmux, metrics)
    await daemon.start()
    try {
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

      expect(tmux.sentKeys).toEqual([])
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(6)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(6)
      expect(metrics.countInc('state_daemon_state_actions_total', {
        action: 'legacy_tui_disabled',
        status: 'pending',
        terminal: 'false',
      })).toBe(6)
    } finally {
      await daemon.stop()
    }
  })
})
