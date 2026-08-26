import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import { buildQueueDoctorReport } from '../../../core/queue-doctor'
import { requeueFailedQueueRows } from '../../../core/queue-repair'
import type { StateDaemonConfig } from '../../../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeCodexRunner,
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
  await pg.query('BEGIN')
})
afterEach(async () => {
  await pg.query('ROLLBACK')
  await cleanAll(pg)
})

function daemon(
  clock: FakeClock,
  codexRunner: FakeCodexRunner,
  config: Partial<StateDaemonConfig> = {},
) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux: new FakeTmux(),
    codexRunner,
    clock,
    metrics,
    alert,
    config: {
      agentIdPrefix: 'sd-test-',
      codexRunnerEnabled: true,
      codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ...config,
    },
  })
  return { daemon: d, metrics, alert }
}

async function seedPendingRow(agent: string) {
  return seedQueueRow(pg, {
    agent_id: agent,
    status: 'pending',
    message_id: '22222222-2222-4222-8222-222222222222',
    payload: JSON.stringify({ author_id: 'codex-cto', content: 'do work', message_type: 'instruction' }),
    created_at: new Date('2026-05-18T00:00:00.000Z'),
  })
}

function pendingEvent(id: string | number, agent: string) {
  return { op: 'INSERT' as const, id, agent_id: agent, status: 'pending', claim_expires_at: null }
}

describe('bounded wake invocation (issue #940: no row loops forever, none is parked silently)', () => {
  test('a pending row is invoked at most N times, then transitions to typed failed with one alert', async () => {
    const agent = makeAgentId('wake-bound')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedPendingRow(agent)

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, { wakeInvocationMaxAttempts: 3 })
    await h.daemon.start()
    try {
      for (let i = 0; i < 3; i += 1) {
        await h.daemon.__testHandleEvent(pendingEvent(id, agent))
        clock.advance(60_000)
      }
      expect(runner.invocations).toHaveLength(3)

      // No external event arrives. The daemon's own periodic sweep must move
      // the exhausted row to typed failed — nothing may stay parked in
      // pending waiting for a 4th delivery event that never comes.
      clock.advance(60_000)
      await h.daemon.sweepStale()
      expect(runner.invocations).toHaveLength(3)

      const row = await pg.query(
        `SELECT status, failed_reason, done_at, claimed_by, payload FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(row.rows[0].status).toBe('failed')
      expect(row.rows[0].failed_reason).toBe('WAKE_INVOCATION_RETRY_EXHAUSTED')
      expect(row.rows[0].done_at).not.toBeNull()
      expect(row.rows[0].claimed_by).toBeNull()
      const payload = JSON.parse(row.rows[0].payload)
      expect(payload.wake_invocation_recovery.attempts).toBe(3)
      expect(payload.wake_invocation_recovery.reason).toBe('WAKE_INVOCATION_RETRY_EXHAUSTED')

      const exhaustionAlerts = h.alert.alerts.filter((a) => a.includes('wake invocation exhausted'))
      expect(exhaustionAlerts).toHaveLength(1)

      // Further events on the failed row change nothing and alert nothing.
      clock.advance(60_000)
      await h.daemon.__testHandleEvent(pendingEvent(id, agent))
      expect(runner.invocations).toHaveLength(3)
      expect(h.alert.alerts.filter((a) => a.includes('wake invocation exhausted'))).toHaveLength(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('typed-failed rows are a queue-doctor blocker until repaired', async () => {
    const agent = makeAgentId('wake-doctor')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedPendingRow(agent)
    await pg.query(
      `UPDATE message_queue
          SET status='failed', failed_reason='WAKE_INVOCATION_RETRY_EXHAUSTED', done_at=now()
        WHERE id=$1`,
      [id],
    )

    const report = await buildQueueDoctorReport(pg, { agentId: agent })
    const blocker = report.blockers.find((f: any) => f.code === 'typed_failed_awaiting_repair')
    expect(blocker).toBeDefined()
    expect(blocker?.severity).toBe('blocker')
    expect(blocker?.count).toBeGreaterThanOrEqual(1)
  })

  test('requeue-failed reopens the row with a fresh attempt budget', async () => {
    const agent = makeAgentId('wake-requeue')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedPendingRow(agent)

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, { wakeInvocationMaxAttempts: 1 })
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent(pendingEvent(id, agent))
      expect(runner.invocations).toHaveLength(1)
      clock.advance(60_000)
      await h.daemon.__testHandleEvent(pendingEvent(id, agent))
      const failed = await pg.query(`SELECT status FROM message_queue WHERE id=$1`, [id])
      expect(failed.rows[0].status).toBe('failed')

      const dry = await requeueFailedQueueRows(pg, { queueIds: [id] })
      expect(dry.dry_run).toBe(true)
      expect(dry.affected_count).toBe(1)

      const executed = await requeueFailedQueueRows(pg, { queueIds: [id], dryRun: false })
      expect(executed.affected_count).toBe(1)

      const reopened = await pg.query(
        `SELECT status, failed_reason, done_at, payload FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(reopened.rows[0].status).toBe('pending')
      expect(reopened.rows[0].failed_reason).toBeNull()
      expect(reopened.rows[0].done_at).toBeNull()
      expect(JSON.parse(reopened.rows[0].payload).wake_invocation_recovery).toBeUndefined()

      // Fresh budget: the reopened row can be invoked again.
      clock.advance(60_000)
      await h.daemon.__testHandleEvent(pendingEvent(id, agent))
      expect(runner.invocations).toHaveLength(2)
    } finally {
      await h.daemon.stop()
    }
  })
})
