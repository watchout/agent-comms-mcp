import { describe, expect, test } from 'bun:test'
import { StateDaemon } from '../core/state-daemon'
import type { DBClient, QueueWorkScheduler } from '../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
} from './contract/state-daemon/fakes'

class SingleRowDb implements DBClient {
  constructor(private readonly row: any) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (
      sql.includes('FROM message_queue WHERE id = $1')
      || (sql.includes('FROM message_queue mq') && sql.includes('WHERE mq.id = $1'))
    ) {
      if (String(this.row.id) === String(params?.[0])) {
        return { rows: [{ ...this.row }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }
}

class RecordingDb implements DBClient {
  queries: Array<{ sql: string; params?: unknown[] }> = []

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push({ sql, params })
    if (sql.includes('count(*)::int AS n')) {
      return { rows: [{ n: 0 }] as T[], rowCount: 1 }
    }
    return { rows: [] as T[], rowCount: 0 }
  }
}

class PendingLlmDb implements DBClient {
  constructor(
    private readonly agentId: string,
    private readonly row: any,
  ) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes('FROM message_queue mq') && sql.includes('WHERE mq.id = $1')) {
      if (String(this.row.id) === String(params?.[0])) return { rows: [{ ...this.row }] as T[], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM agents WHERE agent_id=$1')) {
      return {
        rows: [{
          agent_id: this.agentId,
          runtime: 'codex',
          runtime_engine_preference: 'codex',
          metadata: {},
          tmux_session: null,
          last_seen_at: new Date('2026-05-07T23:59:00.000Z'),
          status: 'idle',
          profile_enabled: true,
          disabled_at: null,
          expected_provider_identity: null,
        }] as T[],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM message_queue') && sql.includes('claimed_by=$1')) {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.includes('profile_revision') && sql.includes('FROM agents')) {
      return {
        rows: [{
          agent_id: this.agentId,
          profile_revision: null,
          profile_source: null,
          channel_port: null,
          home_directory: '/repo',
          metadata: {},
        }] as T[],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM agent_runtime_instances')) {
      return {
        rows: [{
          runtime_instance_id: 'rt-queue-scheduler',
          agent_id: this.agentId,
          session_name: null,
          port: null,
          checkout_path: '/repo',
          commit_sha: null,
          started_at: '2026-05-07T23:50:00.000Z',
          last_seen_at: '2026-05-07T23:59:00.000Z',
          status: 'running',
        }] as T[],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM runtime_memory_ready_evidence')) {
      return {
        rows: [{
          id: 1,
          agent_id: this.agentId,
          project: 'agent-comms-mcp',
          runtime_instance_id: 'rt-queue-scheduler',
          profile_revision: null,
          profile_source: null,
          session_name: null,
          port: null,
          expected_agent_id: this.agentId,
          checkout_path: '/repo',
          checkout_commit_sha: null,
          recovery_command: 'mcp__wasurezu__recover_context',
          result_status: 'ready',
          failure_reason: null,
          completed_at: '2026-05-07T23:55:00.000Z',
          evidence_path: null,
          evidence_log_id: null,
          valid_until: '2026-05-08T01:00:00.000Z',
          source: 'wasurezu_boot_recovery',
          metadata: {},
        }] as T[],
        rowCount: 1,
      }
    }
    return { rows: [] as T[], rowCount: 0 }
  }
}

class ExpiredSchedulerClaimDb implements DBClient {
  updates: Array<{ sql: string; params?: unknown[] }> = []

  constructor(private readonly row: any) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes('FROM message_queue mq') && sql.includes("mq.status IN ('received', 'in_progress')") && sql.includes('mq.claim_expires_at <')) {
      return { rows: [{ ...this.row }] as T[], rowCount: 1 }
    }
    if (sql.includes('FROM message_queue mq') && sql.includes("mq.status IN ('received', 'in_progress')")) {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.includes('FROM message_queue mq') && sql.includes("mq.status='pending'")) {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.trim().startsWith('UPDATE')) {
      this.updates.push({ sql, params })
      return { rows: [] as T[], rowCount: 0 }
    }
    return { rows: [] as T[], rowCount: 0 }
  }
}

describe('state_daemon queue work scheduler boundary', () => {
  test('received queue events schedule the runner without using tmux wake', async () => {
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runReceived(input) {
        calls.push(input)
      },
    }
    const metrics = new FakeMetrics()
    const tmux = new FakeTmux()
    const daemon = new StateDaemon({
      db: new SingleRowDb({
        id: 489,
        agent_id: 'codex-audit',
        status: 'received',
        claim_expires_at: null,
        created_at: new Date('2026-05-21T00:00:00.000Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(),
      tmux,
      clock: new FakeClock(),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler,
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'UPDATE',
        id: 489,
        agent_id: 'codex-audit',
        status: 'received',
        claim_expires_at: null,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(calls).toEqual([{ queueId: 489, agentId: 'codex-audit' }])
    expect(tmux.sentKeys).toEqual([])
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'received_runner_invoked',
    })).toBe(1)
  })

  test('pending LLM queue events use the scheduler when runPending is configured', async () => {
    const agentId = 'codex-audit'
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runPending(input) {
        calls.push(input)
      },
      async runReceived() {
        throw new Error('runReceived should not be called for pending events')
      },
    }
    const metrics = new FakeMetrics()
    const tmux = new FakeTmux()
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, {
        id: 490,
        agent_id: agentId,
        status: 'pending',
        message_id: 'msg-490',
        payload: JSON.stringify({
          author_id: 'codex-cto',
          content: 'Audit PR #490',
          message_type: 'instruction',
        }),
        claim_expires_at: null,
        created_at: new Date('2026-05-08T00:00:00.000Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(),
      tmux,
      clock: new FakeClock(),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler,
      config: { codexRunnerEnabled: true },
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: 490,
        agent_id: agentId,
        status: 'pending',
        claim_expires_at: null,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(calls).toEqual([{ queueId: 490, agentId }])
    expect(tmux.sentKeys).toEqual([])
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'pending_runner_invoked',
    })).toBe(1)
  })

  test('received notify for the same queue row is suppressed while pending runner is in flight', async () => {
    const agentId = 'codex-audit'
    const calls: Array<{ phase: 'pending' | 'received'; queueId: number; agentId: string }> = []
    let releasePending!: () => void
    let pendingStartedResolve!: () => void
    const pendingStarted = new Promise<void>((resolve) => {
      pendingStartedResolve = resolve
    })
    const scheduler: QueueWorkScheduler = {
      async runPending(input) {
        calls.push({ phase: 'pending', ...input })
        pendingStartedResolve()
        await new Promise<void>((release) => {
          releasePending = release
        })
      },
      async runReceived(input) {
        calls.push({ phase: 'received', ...input })
      },
    }
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, {
        id: 491,
        agent_id: agentId,
        status: 'pending',
        message_id: 'msg-491',
        payload: JSON.stringify({
          author_id: 'codex-cto',
          content: 'Audit PR #491',
          message_type: 'instruction',
        }),
        claim_expires_at: null,
        created_at: new Date('2026-05-08T00:00:00.000Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock(),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler,
      config: { codexRunnerEnabled: true },
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: 491,
        agent_id: agentId,
        status: 'pending',
        claim_expires_at: null,
      })
      await pendingStarted
      await daemon.__testHandleEvent({
        op: 'UPDATE',
        id: 491,
        agent_id: agentId,
        status: 'received',
        claim_expires_at: null,
      })

      expect(calls).toEqual([{ phase: 'pending', queueId: 491, agentId }])
      expect(metrics.countInc('state_daemon_queue_work_actions_total', {
        result: 'received_runner_dedup_skipped',
      })).toBe(1)
    } finally {
      releasePending()
      await daemon.stop()
    }
  })

  test('queue-work fence skips pre-existing received residue for the same allowlisted agent', async () => {
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runReceived(input) {
        calls.push(input)
      },
    }
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new SingleRowDb({
        id: 120245,
        agent_id: 'qa',
        status: 'received',
        message_id: 'ab20f921-4b99-4392-960a-673ee834292a',
        payload: JSON.stringify({
          content: 'previous canary residue',
          receive_claim: {
            source: 'state-daemon-queue-work-scheduler',
          },
        }),
        claim_expires_at: new Date('2026-06-15T00:00:30.000Z'),
        created_at: new Date('2026-06-14T08:46:57.674Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-06-15T00:00:00.000Z'),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler,
      config: {
        agentAllowlist: ['qa'],
        queueWorkFenceMessageIds: ['fresh-canary-message-id'],
        queueWorkFenceCreatedAfter: '2026-06-15T00:00:00.000Z',
      },
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'UPDATE',
        id: 120245,
        agent_id: 'qa',
        status: 'received',
        claim_expires_at: '2026-06-15T00:00:30.000Z',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(calls).toEqual([])
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'queue_work_fence_skipped',
      path: 'notify',
    })).toBe(1)
  })

  test('queue-work fence is applied to claim heartbeat refresh SQL', async () => {
    const db = new RecordingDb()
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-06-15T00:00:00.000Z'),
      metrics: new FakeMetrics(),
      alert: new FakeAlertSink(),
      queueWorkScheduler: {
        async runReceived() {},
      },
      config: {
        agentAllowlist: ['qa'],
        queueWorkFenceMessageIds: ['fresh-canary-message-id'],
        queueWorkFenceCreatedAfter: '2026-06-15T00:00:00.000Z',
      },
    })

    await daemon.start()
    try {
      await daemon.refreshClaims()
    } finally {
      await daemon.stop()
    }

    const update = db.queries.find((query) => query.sql.includes('UPDATE message_queue mq'))
    const skipped = db.queries.find((query) => query.sql.includes('count(*)::int AS n'))
    expect(update?.sql).toContain('mq.message_id = ANY')
    expect(update?.sql).toContain('mq.created_at >=')
    expect(skipped?.sql).toContain('mq.message_id = ANY')
    expect(skipped?.sql).toContain('mq.created_at >=')
  })

  test('queue-work fence is applied to sweep fetch SQL', async () => {
    const db = new RecordingDb()
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-06-15T00:00:00.000Z'),
      metrics: new FakeMetrics(),
      alert: new FakeAlertSink(),
      queueWorkScheduler: {
        async runReceived() {},
      },
      config: {
        agentAllowlist: ['qa'],
        queueWorkFenceMessageIds: ['fresh-canary-message-id'],
        queueWorkFenceCreatedAfter: '2026-06-15T00:00:00.000Z',
      },
    })

    await daemon.start()
    try {
      await daemon.sweepStale()
    } finally {
      await daemon.stop()
    }

    const queueSelects = db.queries
      .filter((query) => query.sql.includes('FROM message_queue mq'))
      .filter((query) => query.sql.includes("mq.status='pending'") || query.sql.includes("mq.status IN ('received', 'in_progress')"))
    expect(queueSelects.length).toBeGreaterThanOrEqual(3)
    for (const query of queueSelects) {
      expect(query.sql).toContain('mq.message_id = ANY')
      expect(query.sql).toContain('mq.created_at >=')
    }
  })

  test('scheduler-owned expired rows are not reclaimed into legacy runner when scheduler is disabled', async () => {
    const row = {
      id: 492,
      agent_id: 'qa',
      status: 'received',
      message_id: 'msg-492',
      payload: JSON.stringify({
        content: 'canary',
        receive_claim: {
          mode: 'targeted-receive',
          source: 'state-daemon-queue-work-scheduler',
          agent_id: 'qa',
          queue_id: '492',
        },
      }),
      claim_expires_at: new Date('2026-05-07T23:59:00.000Z'),
      created_at: new Date('2026-05-07T23:58:00.000Z'),
      last_wake_attempt_at: null,
      last_heartbeat_at: null,
    }
    const db = new ExpiredSchedulerClaimDb(row)
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-05-08T00:00:00.000Z'),
      metrics,
      alert: new FakeAlertSink(),
      config: { codexRunnerEnabled: true, agentAllowlist: ['qa'] },
    })

    await daemon.start()
    try {
      const result = await daemon.sweepStale()

      expect(result.scanned).toBe(1)
      expect(result.reclaimed).toBe(0)
      expect(db.updates).toEqual([])
      expect(metrics.countInc('state_daemon_queue_work_actions_total', {
        result: 'scheduler_claim_without_scheduler_skipped',
      })).toBe(1)
    } finally {
      await daemon.stop()
    }
  })
})
