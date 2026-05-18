import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
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
})

function daemon(clock: FakeClock, codexRunner: FakeCodexRunner, tmux = new FakeTmux()) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner,
    clock,
    metrics,
    alert,
    config: {
      agentIdPrefix: 'sd-test-',
      codexRunnerEnabled: true,
      codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
    },
  })
  return { daemon: d, metrics, alert, tmux }
}

function disabledDaemon(clock: FakeClock, codexRunner: FakeCodexRunner) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const tmux = new FakeTmux()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner,
    clock,
    metrics,
    alert,
    config: { agentIdPrefix: 'sd-test-' },
  })
  return { daemon: d, metrics, alert, tmux }
}

describe('state_daemon invoke_codex_runner dispatch boundary', () => {
  test('pending idle Codex runtime invokes runner and never tmux wake', async () => {
    const agent = makeAgentId('codex-runner')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-111111111111',
      payload: JSON.stringify({ author_id: 'codex-cto', content: 'do work' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(1)
      expect(runner.invocations[0]).toMatchObject({
        agentId: agent,
        queueId: id,
        messageId: '11111111-1111-4111-8111-111111111111',
        requester: 'codex-cto',
        databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      })
      expect(runner.invocations[0].ackContent).toContain(`queue_id=${id}`)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('pending busy Codex runtime observes and does not start duplicate runner', async () => {
    const agent = makeAgentId('codex-busy')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
    const pending = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })
    await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      claimed_by: agent,
      claimed_at: new Date('2026-05-18T00:00:00.000Z'),
      claim_expires_at: new Date('2026-05-18T00:01:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: pending,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'observe_busy' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'active_claim_skipped' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('Codex runner execution is disabled by default until operator activation', async () => {
    const agent = makeAgentId('codex-disabled')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = disabledDaemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('runner failure records diagnostics without terminal-failing the row', async () => {
    const agent = makeAgentId('codex-fail')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    runner.result = { ok: false, code: 1, stderr: 'runner failed' }
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      const row = await pg.query(`SELECT status FROM message_queue WHERE id=$1`, [id])
      expect(row.rows[0].status).toBe('pending')
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_error' })).toBe(1)
      expect(h.alert.contains('codex runner failed')).toBe(true)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI pending path still uses wake_pending and tmux send-keys', async () => {
    const agent = makeAgentId('tui-still-wakes')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', tmux_session: `${agent}-session`, status: 'online' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toHaveLength(1)
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'wake_pending' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})
