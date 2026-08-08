/**
 * T1: new_pending_dispatched (#323 fixtures §T1, spec §4.3 row 1).
 *
 *   precondition: agents alpha (TUI, online); message_queue empty.
 *   trigger:      INSERT row → pg_notify (simulated via __testHandleEvent).
 *   expected:
 *     - tmux.sendKeys is not called; TUI prompt injection is disabled
 *     - DB: row remains pending with no wake timestamp
 *     - metric: state_daemon_wake_actions_total{result='tui_wake_disabled'} += 1
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  test('new pending TUI row is observed without prompt injection', async () => {
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
      const rowId = await seedQueueRow(pg, {
        agent_id: agent,
        status: 'pending',
        created_at: t0,
        payload: JSON.stringify({ message_type: 'instruction', content: 'T1 fixture work' }),
      })

      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: rowId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(tmux.sentKeys).toEqual([])

      const got = await pg.query(
        `SELECT status, last_wake_attempt_at FROM message_queue WHERE id=$1`,
        [rowId],
      )
      const row = (got.rows as Array<{ status: string; last_wake_attempt_at: Date | null }>)[0]
      expect(row.status).toBe('pending')
      expect(row.last_wake_attempt_at).toBeNull()

      expect(metrics.countInc('state_daemon_state_actions_total', { action: 'legacy_tui_disabled' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
      // No alerts.
      expect(alert.alerts.length).toBe(0)
    } finally {
      await daemon.stop()
    }
  })

  test('state daemon source does not contain natural-language wake prompts', () => {
    const src = readFileSync(join(import.meta.dir, '../../../core/state-daemon/index.ts'), 'utf8')
    expect(src).not.toContain('Call the agent-comms next tool now. Do not call inbox.')
    expect(src).not.toContain('Start processing the agent-comms message you just received')
    expect(src).not.toContain('processing tool for its queue_id')
  })
})
