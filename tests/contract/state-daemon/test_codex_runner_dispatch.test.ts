import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import type { DBClient, StateDaemonConfig } from '../../../core/state-daemon/types'
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
  tmux = new FakeTmux(),
  config: Partial<StateDaemonConfig> = {},
) {
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
      ...config,
    },
  })
  return { daemon: d, metrics, alert, tmux }
}

function scopedDaemon(
  clock: FakeClock,
  codexRunner: FakeCodexRunner,
  agentAllowlist: string[],
  tmux = new FakeTmux(),
) {
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
      agentAllowlist,
      codexRunnerEnabled: true,
      codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
    },
  })
  return { daemon: d, metrics, alert, tmux }
}

function denylistDaemon(
  clock: FakeClock,
  codexRunner: FakeCodexRunner,
  agentDenylist: string[],
  tmux = new FakeTmux(),
) {
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
      agentDenylist,
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

class CloseRowAfterReserveDB implements DBClient {
  private readonly delegate: PgDBClient
  constructor(
    private readonly client: Client,
    private readonly queueId: number,
  ) {
    this.delegate = new PgDBClient(client)
  }

  async query<T = any>(sql: string, params?: unknown[]) {
    const result = await this.delegate.query<T>(sql, params)
    if (sql.includes('UPDATE agents') && sql.includes('last_wake_attempt_at=$1')) {
      await this.client.query(
        `UPDATE message_queue
            SET status='replied',
                replied_at=now(),
                replied_with='99999999-9999-4999-8999-999999999999'
          WHERE id=$1`,
        [this.queueId],
      )
    }
    return result
  }
}

describe('state_daemon invoke_codex_runner dispatch boundary', () => {
  test('pending idle Codex runtime invokes runner and never tmux wake', async () => {
    const agent = makeAgentId('codex-runner')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-111111111111',
      payload: JSON.stringify({ author_id: 'codex-cto', content: 'do work', message_type: 'instruction' }),
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
        payload: JSON.stringify({ author_id: 'codex-cto', content: 'do work', message_type: 'instruction' }),
        completeNoReply: false,
        completionReason: null,
      })
      expect(runner.invocations[0].ackContent).toContain('queue_id={queue_id}')
      expect(runner.invocations[0].ackContent).toContain('message_id={message_id}')
      expect(runner.invocations[0].ackContent).not.toContain(`queue_id=${id}`)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('direct mention smoke is passed to auto-final reply without daemon ACK', async () => {
    const agent = makeAgentId('codex-smoke')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      discord_id: '999010',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-333333333333',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: '<@999010> 疎通テスト',
        message_type: 'chat',
        source: 'discord',
        input_mentions: ['999010'],
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    runner.result = {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        retained_count: 1,
        retained: [{ queue_id: String(id), message_id: '11111111-1111-4111-8111-333333333333' }],
        completion: {
          outcome: 'completed_reply',
          terminal_queue_ids: [String(id)],
          reason: 'auto_final_reply_completed',
        },
      }) + '\n',
      stderr: '',
      typed_result: {
        outcome: 'claimed_work',
        retained_count: 1,
        queue_ids: [String(id)],
        completion_outcome: 'completed_reply',
        terminal_queue_ids: [String(id)],
        completion_reason: 'auto_final_reply_completed',
      },
    }
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, new FakeTmux(), { codexRunnerAutoFinalReply: true })
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
        queueId: id,
        completeNoReply: false,
        completionReason: null,
        autoFinalReply: true,
        ackContent: '',
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_final_replied' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('auto-final reply mode passes exact queue without daemon-authored ACK prose', async () => {
    const agent = makeAgentId('codex-final')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      discord_id: '999010',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-444444444444',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: '<@999010> 日本語で返答して',
        message_type: 'chat',
        source: 'discord',
        input_mentions: ['999010'],
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    runner.result = {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        retained_count: 1,
        retained: [{ queue_id: String(id), message_id: '11111111-1111-4111-8111-444444444444' }],
        completion: {
          outcome: 'completed_reply',
          terminal_queue_ids: [String(id)],
          reason: 'auto_final_reply_completed',
        },
      }) + '\n',
      stderr: '',
      typed_result: {
        outcome: 'claimed_work',
        retained_count: 1,
        queue_ids: [String(id)],
        completion_outcome: 'completed_reply',
        terminal_queue_ids: [String(id)],
        completion_reason: 'auto_final_reply_completed',
      },
    }
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, new FakeTmux(), { codexRunnerAutoFinalReply: true })
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
        queueId: id,
        requester: 'codex-cto',
        completeNoReply: false,
        completionReason: null,
        autoFinalReply: true,
        ackContent: '',
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_final_replied' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_open' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('structured no-reply terminal work is completed by state_daemon without invoking runner', async () => {
    const agent = makeAgentId('codex-complete')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-222222222222',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: 'NORM-060 synthetic probe',
        no_reply_required: true,
      }),
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

      expect(runner.invocations).toHaveLength(0)
      const row = await pg.query<{ status: string; done_at: Date | null; payload: string }>(
        `SELECT status, done_at, payload FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(row.rows[0]?.status).toBe('done')
      expect(row.rows[0]?.done_at).toBeTruthy()
      expect(JSON.parse(row.rows[0]?.payload ?? '{}').terminal_baton).toMatchObject({
        no_reply_required: true,
        reason: 'payload_no_reply_required',
        set_by: 'state_daemon',
        source: 'deterministic_no_reply_policy',
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'state_daemon_no_reply_completed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_terminal_completed' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI no-reply terminal work is completed without prompt injection', async () => {
    const agent = makeAgentId('tui-no-reply')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'idle',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-555555555555',
      payload: JSON.stringify({
        author_id: 'state-daemon-smoke',
        content: 'NORM-060 synthetic probe',
        no_reply_required: true,
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const tmux = new FakeTmux()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, tmux)
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
      expect(tmux.sentKeys).toEqual([])
      const row = await pg.query<{ status: string; done_at: Date | null }>(
        `SELECT status, done_at FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(row.rows[0]).toMatchObject({ status: 'done' })
      expect(row.rows[0]?.done_at).toBeTruthy()
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'state_daemon_no_reply_completed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('pending busy Codex runtime observes and does not start duplicate runner', async () => {
    const agent = makeAgentId('codex-busy')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
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
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
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
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
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

  test('stale pending event does not invoke runner after row was already closed', async () => {
    const agent = makeAgentId('codex-stale-event')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    const metrics = new FakeMetrics()
    const alert = new FakeAlertSink()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const d = new StateDaemon({
      db: new CloseRowAfterReserveDB(pg, id),
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      codexRunner: runner,
      clock,
      metrics,
      alert,
      config: {
        agentIdPrefix: 'sd-test-',
        codexRunnerEnabled: true,
        codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
      },
    })

    await d.start()
    try {
      await d.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_stale_skipped' })).toBe(1)
      expect(alert.alerts).toEqual([])
      const row = await pg.query(`SELECT status, replied_with FROM message_queue WHERE id=$1`, [id])
      expect(row.rows[0]).toMatchObject({
        status: 'replied',
        replied_with: '99999999-9999-4999-8999-999999999999',
      })
    } finally {
      await d.stop()
    }
  })

  test('TUI pending path is observed but does not inject wake prompts', async () => {
    const agent = makeAgentId('tui-wake-disabled')
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
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'wake_pending' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI legacy profile with Codex preference invokes runner without tmux prompt injection', async () => {
    const agent = makeAgentId('tui-codex-preference')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      runtime_engine_preference: 'codex',
      tmux_session: `${agent}-session`,
      status: 'idle',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-333333333333',
      payload: JSON.stringify({ author_id: 'ceo', content: '<@999010> 疎通テスト', message_type: 'instruction' }),
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
        requester: 'ceo',
      })
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI legacy profile with Codex preference and no tmux session bypasses stall gate and invokes runner', async () => {
    const agent = makeAgentId('tui-codex-no-tmux-runner')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      runtime_engine_preference: 'codex',
      tmux_session: null,
      status: 'idle',
      last_seen_at: '2026-05-18T00:00:00.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-444444444444',
      payload: JSON.stringify({ author_id: 'ceo', content: '<@999010> 疎通テスト without tmux', message_type: 'instruction' }),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:05:00.000Z')
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
        requester: 'ceo',
      })
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_stall_skipped_total', { kind: 'tmux_missing' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'stall_skipped' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent allowlist ignores pg_notify rows outside the activation scope', async () => {
    const allowed = makeAgentId('allowed-codex')
    const blocked = makeAgentId('blocked-codex')
    await seedAgent(pg, { agent_id: allowed, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    await seedAgent(pg, { agent_id: blocked, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    const blockedId = await seedQueueRow(pg, { agent_id: blocked, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = scopedDaemon(clock, runner, [allowed])
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: blockedId,
        agent_id: blocked,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_scope_skipped_total', { path: 'notify' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_state_actions_total')).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent allowlist limits stale sweep wake to selected agents', async () => {
    const allowed = makeAgentId('allowed-tui')
    const blocked = makeAgentId('blocked-tui')
    await seedAgent(pg, { agent_id: allowed, runtime: 'TUI', tmux_session: `${allowed}-session`, status: 'online' })
    await seedAgent(pg, { agent_id: blocked, runtime: 'TUI', tmux_session: `${blocked}-session`, status: 'online' })
    const old = new Date('2026-05-18T00:00:00.000Z')
    await seedQueueRow(pg, { agent_id: allowed, status: 'pending', created_at: old })
    await seedQueueRow(pg, { agent_id: blocked, status: 'pending', created_at: old })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:30.000Z')
    const h = scopedDaemon(clock, runner, [allowed])
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()

      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'wake_pending' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent denylist excludes stale sweep wake while preserving fleet default', async () => {
    const allowed = makeAgentId('denied-sweep-allowed')
    const denied = makeAgentId('denied-sweep-blocked')
    await seedAgent(pg, { agent_id: allowed, runtime: 'TUI', tmux_session: `${allowed}-session`, status: 'online' })
    await seedAgent(pg, { agent_id: denied, runtime: 'TUI', tmux_session: `${denied}-session`, status: 'online' })
    const old = new Date('2026-05-18T00:00:00.000Z')
    await seedQueueRow(pg, { agent_id: allowed, status: 'pending', created_at: old })
    await seedQueueRow(pg, { agent_id: denied, status: 'pending', created_at: old })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:30.000Z')
    const h = denylistDaemon(clock, runner, [denied])
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()

      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'wake_pending' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent denylist ignores pg_notify rows while allowing non-denied fleet rows', async () => {
    const allowed = makeAgentId('denied-sibling-allowed')
    const denied = makeAgentId('denied-sibling-blocked')
    await seedAgent(pg, { agent_id: allowed, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    await seedAgent(pg, { agent_id: denied, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    const deniedId = await seedQueueRow(pg, { agent_id: denied, status: 'pending' })
    const allowedId = await seedQueueRow(pg, { agent_id: allowed, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = denylistDaemon(clock, runner, [denied])
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: deniedId,
        agent_id: denied,
        status: 'pending',
        claim_expires_at: null,
      })
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: allowedId,
        agent_id: allowed,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations.map((x) => x.agentId)).toEqual([allowed])
      expect(h.metrics.countInc('state_daemon_scope_skipped_total', { path: 'notify' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('offline agents are not auto-restarted when full-fleet scope is enabled', async () => {
    const agent = makeAgentId('offline-no-restart')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', tmux_session: null, status: 'offline' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:05:00.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      const result = await h.daemon.checkBotLiveness()

      expect(result).toEqual({ checked: 0, restarted: 0, escalated: 0 })
      expect(h.tmux.restarts).toEqual([])
      expect(h.metrics.countInc('state_daemon_bot_liveness_skipped_total', { status: 'offline' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI legacy profile with Codex preference is not treated as a tmux restart target', async () => {
    const agent = makeAgentId('tui-codex-no-restart')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      runtime_engine_preference: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:00.000Z',
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:05:00.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      const result = await h.daemon.checkBotLiveness()

      expect(result).toEqual({ checked: 1, restarted: 0, escalated: 0 })
      expect(h.tmux.restarts).toEqual([])
      expect(h.metrics.countInc('state_daemon_bot_liveness_skipped_total', { runtime: 'codex' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})
