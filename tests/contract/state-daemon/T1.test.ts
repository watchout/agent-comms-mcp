/**
 * T1: new_pending_dispatched (#323 fixtures §T1, spec §4.3 row 1).
 *
 *   precondition: agents alpha (TUI, online); message_queue empty.
 *   trigger:      INSERT row → pg_notify (simulated via __testHandleEvent).
 *   expected:
 *     - tmux.sendKeys('alpha-session', 'check inbox\n') 1 回
 *     - DB: row.last_wake_attempt_at = T0
 *     - metric: state_daemon_wake_actions_total{result='ok'} += 1
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

describe('T1 new_pending_dispatched', () => {
  test('new pending row → wake target tmux + last_wake_attempt_at + metric ok', async () => {
    const agent = makeAgentId('t1-alpha')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'online',
    })

    const t0 = new Date('2026-05-08T00:00:00.000Z')
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
      config: { agentIdPrefix: 'sd-test-' },
    })
    await daemon.start()
    try {
      // Insert the row directly so we control the id; the trigger fires its own
      // pg_notify on the real DB but FakePgListen is what the daemon listens to,
      // so we drive the event ourselves to keep the test deterministic.
      const ins = await pg.query(
        `INSERT INTO message_queue (agent_id, status, payload, created_at)
         VALUES ($1, 'pending', '{}', $2) RETURNING id`,
        [agent, t0],
      )
      const rowId = Number((ins.rows as Array<{ id: number }>)[0].id)

      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: rowId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      // tmux.sendKeys called once with the right target + payload.
      expect(tmux.sentKeys.length).toBe(1)
      expect(tmux.sentKeys[0].session).toBe(`${agent}-session`)
      expect(tmux.sentKeys[0].payload).toBe('check inbox\n')

      // DB: last_wake_attempt_at = t0 (within ~1s tolerance for tz parsing)
      const got = await pg.query(
        `SELECT last_wake_attempt_at FROM message_queue WHERE id=$1`,
        [rowId],
      )
      const ts = (got.rows as Array<{ last_wake_attempt_at: Date | null }>)[0].last_wake_attempt_at
      expect(ts).not.toBeNull()
      expect(Math.abs(new Date(ts!).getTime() - t0.getTime())).toBeLessThan(1500)

      // metric: ok += 1
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'ok' })).toBe(1)
      // No alerts.
      expect(alert.alerts.length).toBe(0)
    } finally {
      await daemon.stop()
    }
  })
})
