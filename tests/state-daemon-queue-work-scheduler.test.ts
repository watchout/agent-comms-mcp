import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RuntimeV2ShirubeD1AutoReceiveDispatcher,
  SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
  describeQueueWorkFailure,
  exactClaimFenceFromTargetedReceive,
  loadQueueWorkResidueExcludedQueueIds,
  resolveQueueWorkRuntimeWorkspace,
} from '../bin/state-daemon'
import { StateDaemon } from '../core/state-daemon'
import type {
  DBClient,
  QueueWorkScheduler,
  ShirubeD1AutoReceiveDispatcher,
} from '../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
} from './contract/state-daemon/fakes'

const REPO = join(import.meta.dir, '..')
const AUTHORITY_CHANNEL_ID = 'state-daemon-scheduler-fixture'

function authorityFixtureResult<T>(sql: string, agentId: string): { rows: T[]; rowCount: number } | null {
  if (sql.includes('profile_enabled, disabled_at') && sql.includes('FROM agents')) {
    return {
      rows: [{
        agent_id: agentId,
        runtime: 'codex',
        runtime_engine_preference: 'codex',
        status: 'idle',
        profile_enabled: true,
        disabled_at: null,
      }] as T[],
      rowCount: 1,
    }
  }
  if (sql.includes('SELECT members FROM channels WHERE id=$1')) {
    return { rows: [{ members: [agentId] }] as T[], rowCount: 1 }
  }
  return null
}

test('queue-work failure reporting surfaces the failed finalizer instead of the successful runner', () => {
  const detail = describeQueueWorkFailure({
    ok: false,
    dry_run: false,
    plan: {} as any,
    runner: { ok: true, code: 'DONE' },
    finalizer: {
      ok: false,
      code: 'REPLY_SEND_FAILED',
      detail: 'spawn bun ENOENT',
    },
  })

  expect(detail).toContain('REPLY_SEND_FAILED')
  expect(detail).toContain('spawn bun ENOENT')
  expect(detail).not.toContain('"code":"DONE"')
})

test('queue-work runtime workspace resolves from the enabled agent DB binding', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'queue-work-agent-workspace-'))
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  try {
    const resolved = await resolveQueueWorkRuntimeWorkspace({
      async query<T>(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        return {
          rows: [{ agent_id: 'codex-audit', runtime_workspace: workspace }] as T[],
          rowCount: 1,
        }
      },
    }, 'codex-audit')

    expect(resolved).toBe(realpathSync(workspace))
    expect(calls[0]?.params).toEqual(['codex-audit'])
    expect(calls[0]?.sql).toContain('agent_workspace_bindings')
    expect(calls[0]?.sql).toContain('a.profile_enabled = true')
    expect(calls[0]?.sql).toContain('a.disabled_at IS NULL')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('queue-work runtime workspace fails closed on missing, relative, or absent DB paths', async () => {
  const cases = [
    { rows: [], message: 'requires one enabled DB agent row' },
    { rows: [{ agent_id: 'codex-audit', runtime_workspace: 'relative/path' }], message: 'must be an absolute DB path' },
    { rows: [{ agent_id: 'codex-audit', runtime_workspace: '/definitely/missing/aun-workspace' }], message: 'does not exist as a directory' },
  ]
  for (const fixture of cases) {
    await expect(resolveQueueWorkRuntimeWorkspace({
      async query<T>() {
        return { rows: fixture.rows as T[], rowCount: fixture.rows.length }
      },
    }, 'codex-audit')).rejects.toThrow(fixture.message)
  }
})

class SingleRowDb implements DBClient {
  constructor(private readonly row: any) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const authority = authorityFixtureResult<T>(sql, this.row.agent_id)
    if (authority) return authority
    if (
      sql.includes('FROM message_queue WHERE id = $1')
      || (sql.includes('FROM message_queue mq') && sql.includes('WHERE mq.id = $1'))
    ) {
      if (String(this.row.id) === String(params?.[0])) {
        return { rows: [{ channel_id: AUTHORITY_CHANNEL_ID, ...this.row }] as T[], rowCount: 1 }
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
    const authority = authorityFixtureResult<T>(sql, this.agentId)
    if (authority) return authority
    if (sql.includes('FROM message_queue mq') && sql.includes('WHERE mq.id = $1')) {
      if (String(this.row.id) === String(params?.[0])) return { rows: [{ channel_id: AUTHORITY_CHANNEL_ID, ...this.row }] as T[], rowCount: 1 }
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
          valid_until: '2030-05-08T01:00:00.000Z',
          source: 'wasurezu_boot_recovery',
          metadata: {},
        }] as T[],
        rowCount: 1,
      }
    }
    return { rows: [] as T[], rowCount: 0 }
  }
}

class MultiPendingLlmDb implements DBClient {
  private readonly delegatesById = new Map<string, PendingLlmDb>()
  private readonly delegatesByAgent = new Map<string, PendingLlmDb>()
  private readonly members: string[]
  private readonly first: PendingLlmDb

  constructor(rows: any[]) {
    if (rows.length === 0) throw new Error('MultiPendingLlmDb requires at least one row')
    this.members = [...new Set(rows.map((row) => String(row.agent_id)))]
    this.first = new PendingLlmDb(rows[0].agent_id, rows[0])
    for (const row of rows) {
      const delegate = new PendingLlmDb(row.agent_id, row)
      this.delegatesById.set(String(row.id), delegate)
      if (!this.delegatesByAgent.has(row.agent_id)) this.delegatesByAgent.set(row.agent_id, delegate)
    }
  }

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes('SELECT members FROM channels WHERE id=$1')) {
      return { rows: [{ members: this.members }] as T[], rowCount: 1 }
    }
    if (
      sql.includes('FROM message_queue mq')
      && sql.includes('WHERE mq.id = $1')
    ) {
      const delegate = this.delegatesById.get(String(params?.[0]))
      return delegate ? delegate.query<T>(sql, params) : { rows: [], rowCount: 0 }
    }
    const delegate = this.delegatesByAgent.get(String(params?.[0])) ?? this.first
    return delegate.query<T>(sql, params)
  }
}

class RecordingMultiPendingLlmDb extends MultiPendingLlmDb {
  queries: Array<{ sql: string; params?: unknown[] }> = []

  override async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push({ sql, params })
    return super.query<T>(sql, params)
  }
}

class ExpiredSchedulerClaimDb implements DBClient {
  updates: Array<{ sql: string; params?: unknown[] }> = []

  constructor(private readonly row: any) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const authority = authorityFixtureResult<T>(sql, this.row.agent_id)
    if (authority) return authority
    if (sql.includes('FROM message_queue mq') && sql.includes("mq.status IN ('received', 'in_progress')") && sql.includes('mq.claim_expires_at <')) {
      return { rows: [{ channel_id: AUTHORITY_CHANNEL_ID, ...this.row }] as T[], rowCount: 1 }
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

class RunnerErrorSweepDb implements DBClient {
  updates: Array<{ sql: string; params?: unknown[] }> = []

  constructor(public row: any) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const authority = authorityFixtureResult<T>(sql, this.row.agent_id)
    if (authority) return authority
    if (
      sql.includes('FROM message_queue mq')
      && sql.includes("mq.status='in_progress'")
      && sql.includes('runner_error')
    ) {
      const excludedIds = (params ?? [])
        .filter((param): param is number[] => Array.isArray(param) && param.every((item) => typeof item === 'number'))
        .flat()
      if (excludedIds.includes(Number(this.row?.id))) {
        return { rows: [] as T[], rowCount: 0 }
      }
      if (this.row?.status === 'in_progress') {
        return { rows: [{ channel_id: AUTHORITY_CHANNEL_ID, ...this.row }] as T[], rowCount: 1 }
      }
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.includes('FROM message_queue mq') && sql.includes("mq.status IN ('received', 'in_progress')")) {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.includes('FROM message_queue mq') && sql.includes("mq.status='pending'")) {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.includes('count(*)::int AS n')) {
      return { rows: [{ n: 0 }] as T[], rowCount: 1 }
    }
    if (sql.trim().startsWith('UPDATE message_queue')) {
      this.updates.push({ sql, params })
      if (!this.row || String(this.row.id) !== String(params?.[0]) || this.row.status !== 'in_progress') {
        return { rows: [] as T[], rowCount: 0 }
      }
      if (sql.includes("SET status='pending'")) {
        this.row.status = 'pending'
        this.row.payload = params?.[1]
      } else if (sql.includes("SET status='failed'")) {
        this.row.status = 'failed'
        this.row.failed_reason = params?.[1]
        this.row.done_at = params?.[2]
        this.row.payload = params?.[3]
      }
      this.row.claimed_by = null
      this.row.claimed_at = null
      this.row.claim_expires_at = null
      this.row.last_heartbeat_at = null
      return { rows: [] as T[], rowCount: 1 }
    }
    return { rows: [] as T[], rowCount: 0 }
  }
}

class D1DoneRecoveryDb implements DBClient {
  constructor(private readonly row: any) {}

  async query<T = any>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    const authority = authorityFixtureResult<T>(sql, this.row.agent_id)
    if (authority) return authority
    if (sql.includes("mq.status = 'done'") && sql.includes('shirube_v4_d1')) {
      return { rows: [{ channel_id: AUTHORITY_CHANNEL_ID, ...this.row }] as T[], rowCount: 1 }
    }
    if (sql.includes('count(*)::int AS n')) return { rows: [{ n: 0 }] as T[], rowCount: 1 }
    return { rows: [] as T[], rowCount: 0 }
  }
}

class D1ExpiredClaimRecoveryDb implements DBClient {
  updates = 0
  constructor(private readonly row: any) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const authority = authorityFixtureResult<T>(sql, this.row.agent_id)
    if (authority) return authority
    if (sql.includes("mq.status IN ('received', 'in_progress')") && sql.includes('mq.claim_expires_at <')) {
      return this.row.status === 'received'
        ? { rows: [{ channel_id: AUTHORITY_CHANNEL_ID, ...this.row }] as T[], rowCount: 1 }
        : { rows: [] as T[], rowCount: 0 }
    }
    if (sql.trim().startsWith('UPDATE message_queue') && String(params?.[0]) === String(this.row.id)) {
      this.updates += 1
      this.row.status = 'pending'
      this.row.claimed_by = null
      this.row.claimed_at = null
      this.row.claim_expires_at = null
      return { rows: [] as T[], rowCount: 1 }
    }
    if (sql.includes('count(*)::int AS n')) return { rows: [{ n: 0 }] as T[], rowCount: 1 }
    return { rows: [] as T[], rowCount: 0 }
  }
}

describe('state_daemon queue work scheduler boundary', () => {
  test('targeted receive output becomes the exact immutable runner claim fence', () => {
    const fence = exactClaimFenceFromTargetedReceive({
      ok: true,
      code: 0,
      stdout: '',
      stderr: '',
      plan: {} as any,
      summary: {
        ok: true,
        dry_run: false,
        mode: 'targeted-receive',
        agent_id: 'qa',
        expected_agent_id: 'qa',
        queue_id: '42',
        selected: null,
        claimed: {
          waiting: 0,
          queue_id: 42,
          claimed_by: 'qa',
          claimed_at: '2026-08-02T01:00:00.123Z',
          claim_expires_at: '2026-08-02T01:01:00.123Z',
        },
        waiting: 0,
        blocked_reason: null,
        observed_status: 'pending',
      },
    }, { queueId: 42, agentId: 'qa' })

    expect(fence).toEqual({
      claimedBy: 'qa',
      claimedAt: '2026-08-02T01:00:00.123Z',
    })
  })

  test('targeted receive fence rejects a different queue incarnation', () => {
    expect(() => exactClaimFenceFromTargetedReceive({
      ok: true,
      code: 0,
      stdout: '',
      stderr: '',
      plan: {} as any,
      summary: {
        claimed: {
          waiting: 0,
          queue_id: 43,
          claimed_by: 'qa',
          claimed_at: '2026-08-02T01:00:00.000Z',
          claim_expires_at: '2026-08-02T01:01:00.000Z',
        },
      } as any,
    }, { queueId: 42, agentId: 'qa' })).toThrow('no exact claim fence')
  })

  test('valid D1 phase_handoff uses only D1 dispatch under production-composed schedulers', async () => {
    const agentId = 'dev-001'
    const calls: Array<{ queueId: number; agentId: string }> = []
    const genericCalls: string[] = []
    const scheduler: QueueWorkScheduler = {
      async runPending() { genericCalls.push('pending') },
      async runReceived() { genericCalls.push('received') },
    }
    const d1: ShirubeD1AutoReceiveDispatcher = {
      classify: () => ({ outcome: 'admit' }),
      async dispatch(input) {
        calls.push({ queueId: input.queueId, agentId: input.agentId })
        return { code: 'E2E_DONE', replayed: false }
      },
    }
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, {
        id: 88701,
        agent_id: agentId,
        status: 'pending',
        message_id: 'msg-d1-valid',
        payload: JSON.stringify({ message_type: 'phase_handoff', shirube_v4_d1: {} }),
        claim_expires_at: null,
        created_at: new Date('2026-07-23T00:00:00.000Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics, alert: new FakeAlertSink(), queueWorkScheduler: scheduler, shirubeD1AutoReceive: d1,
    })
    await daemon.start()
    try {
      await daemon.__testHandleEvent({ op: 'INSERT', id: 88701, agent_id: agentId, status: 'pending', claim_expires_at: null })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }
    expect(calls).toEqual([{ queueId: 88701, agentId }])
    expect(genericCalls).toEqual([])
    expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'started' })).toBe(1)
    expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'terminal', code: 'E2E_DONE' })).toBe(1)
    expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'routing_non_actionable_held' })).toBe(0)
  })

  test('D1-shaped rejection fails closed without generic routing or dispatch', async () => {
    const agentId = 'dev-001'
    let dispatches = 0
    const genericCalls: string[] = []
    const scheduler: QueueWorkScheduler = {
      async runPending() { genericCalls.push('pending') },
      async runReceived() { genericCalls.push('received') },
    }
    const d1: ShirubeD1AutoReceiveDispatcher = {
      classify: () => ({ outcome: 'reject', reason: 'D1_AUTHORIZATION_DIGEST_MISMATCH' }),
      async dispatch() { dispatches += 1; return { code: 'unexpected', replayed: false } },
    }
    const metrics = new FakeMetrics()
    const alerts = new FakeAlertSink()
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, {
        id: 88702, agent_id: agentId, status: 'received', message_id: 'msg-d1-invalid',
        payload: JSON.stringify({ message_type: 'phase_handoff', shirube_v4_d1: {} }),
        claim_expires_at: null, created_at: new Date('2026-07-23T00:00:00.000Z'),
        last_wake_attempt_at: null, last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics, alert: alerts, queueWorkScheduler: scheduler, shirubeD1AutoReceive: d1,
    })
    await daemon.start()
    try {
      await daemon.__testHandleEvent({ op: 'UPDATE', id: 88702, agent_id: agentId, status: 'received', claim_expires_at: null })
    } finally {
      await daemon.stop()
    }
    expect(dispatches).toBe(0)
    expect(genericCalls).toEqual([])
    expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', {
      result: 'rejected', reason: 'D1_AUTHORIZATION_DIGEST_MISMATCH',
    })).toBe(1)
    expect(alerts.alerts.join('\n')).toContain('D1_AUTHORIZATION_DIGEST_MISMATCH')
    expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'routing_non_actionable_held' })).toBe(0)
  })

  test('duplicate pending notifications share one in-flight D1 dispatch', async () => {
    const agentId = 'dev-001'
    let dispatches = 0
    const genericCalls: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const d1: ShirubeD1AutoReceiveDispatcher = {
      classify: () => ({ outcome: 'admit' }),
      async dispatch() {
        dispatches += 1
        await blocked
        return { code: 'E2E_DONE', replayed: false }
      },
    }
    const metrics = new FakeMetrics()
    const row = {
      id: 88703, agent_id: agentId, status: 'pending', message_id: 'msg-d1-duplicate',
      payload: JSON.stringify({ message_type: 'phase_handoff', shirube_v4_d1: {} }),
      claim_expires_at: null, created_at: new Date('2026-07-23T00:00:00.000Z'),
      last_wake_attempt_at: null, last_heartbeat_at: null,
    }
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, row),
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics, alert: new FakeAlertSink(), shirubeD1AutoReceive: d1,
      queueWorkScheduler: {
        async runPending() { genericCalls.push('pending') },
        async runReceived() { genericCalls.push('received') },
      },
    })
    await daemon.start()
    try {
      const event = { op: 'INSERT', id: 88703, agent_id: agentId, status: 'pending', claim_expires_at: null } as const
      await Promise.all([daemon.__testHandleEvent(event), daemon.__testHandleEvent(event)])
      row.status = 'received'
      await daemon.__testHandleEvent({ ...event, op: 'UPDATE', status: 'received' })
      expect(dispatches).toBe(1)
      expect(genericCalls).toEqual([])
      expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'duplicate_notify' })).toBe(1)
      release()
    } finally {
      release()
      await daemon.stop()
    }
  })

  test('production D1 dispatcher uses exact fences, canonical source, finalize, and codex-exec by default', async () => {
    let options: any
    const dispatcher = new RuntimeV2ShirubeD1AutoReceiveDispatcher({} as NodeJS.ProcessEnv, REPO, async (input) => {
      options = input
      return {
        ok: true,
        dry_run: false,
        plan: {} as any,
        outcome: { ok: true, dry_run: false, code: 'E2E_DONE', plan: {} as any, claimed: {} as any, runner: {} as any },
      }
    })
    await expect(dispatcher.dispatch({
      queueId: 88704, agentId: 'dev-001', messageId: 'msg-d1-exact',
      createdAt: '2026-07-23T00:00:00.000Z', status: 'pending', payload: {},
    })).resolves.toEqual({ code: 'E2E_DONE', replayed: false })
    expect(options).toMatchObject({
      agentId: 'dev-001', queueId: '88704', messageId: 'msg-d1-exact',
      createdAfter: '2026-07-23T00:00:00.000Z', runtime: 'codex-exec', finalize: true,
      claimSource: SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
      invocationSource: SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
      expectedClaimSource: SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
    })
  })

  test('done D1 notification resumes finalization and is reported as replay', async () => {
    const agentId = 'dev-001'
    const calls: string[] = []
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new SingleRowDb({
        id: 88705, agent_id: agentId, status: 'done', message_id: 'msg-d1-done',
        payload: JSON.stringify({ shirube_v4_d1: {} }),
        claim_expires_at: null, created_at: new Date('2026-07-23T00:00:00.000Z'),
        last_wake_attempt_at: null, last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics, alert: new FakeAlertSink(),
      shirubeD1AutoReceive: {
        classify: () => ({ outcome: 'admit' }),
        async dispatch(input) { calls.push(input.status); return { code: 'E2E_DONE', replayed: true } },
      },
    })
    await daemon.start()
    try {
      await daemon.__testHandleEvent({ op: 'UPDATE', id: 88705, agent_id: agentId, status: 'done', claim_expires_at: null })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }
    expect(calls).toEqual(['done'])
    expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'resume_started' })).toBe(1)
    expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'replayed', code: 'E2E_DONE' })).toBe(1)
  })

  test('post-restart sweep recovers a done D1 row without generic scheduler', async () => {
    const agentId = 'dev-001'
    let dispatches = 0
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new D1DoneRecoveryDb({
        id: 88706, agent_id: agentId, status: 'done', message_id: 'msg-d1-restart',
        payload: JSON.stringify({ shirube_v4_d1: {} }),
        claim_expires_at: null, claimed_at: new Date('2026-07-23T00:00:00.000Z'),
        created_at: new Date('2026-07-23T00:00:00.000Z'),
        last_wake_attempt_at: null, last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics, alert: new FakeAlertSink(),
      shirubeD1AutoReceive: {
        classify: () => ({ outcome: 'admit' }),
        async dispatch() { dispatches += 1; return { code: 'E2E_DONE', replayed: true } },
      },
    })
    await daemon.start()
    try {
      const result = await daemon.sweepStale()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(result.rewoken).toBe(1)
    } finally {
      await daemon.stop()
    }
    expect(dispatches).toBe(1)
    expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'resume_started' })).toBe(1)
  })

  test('post-restart sweep reclaims an expired D1 claim and dispatches it once', async () => {
    const agentId = 'dev-001'
    const db = new D1ExpiredClaimRecoveryDb({
      id: 88707, agent_id: agentId, status: 'received', message_id: 'msg-d1-expired',
      payload: JSON.stringify({ shirube_v4_d1: {}, receive_claim: { source: SHIRUBE_D1_AUTO_RECEIVE_SOURCE } }),
      claimed_by: agentId,
      claim_expires_at: new Date('2026-07-22T23:59:00.000Z'),
      claimed_at: new Date('2026-07-22T23:58:00.000Z'),
      created_at: new Date('2026-07-22T23:57:00.000Z'),
      last_wake_attempt_at: null, last_heartbeat_at: null,
    })
    let dispatches = 0
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db, pgListen: new FakePgListen(), tmux: new FakeTmux(),
      clock: new FakeClock('2026-07-23T00:00:00.000Z'), metrics, alert: new FakeAlertSink(),
      shirubeD1AutoReceive: {
        classify: () => ({ outcome: 'admit' }),
        async dispatch(input) {
          expect(input.status).toBe('pending')
          dispatches += 1
          return { code: 'E2E_DONE', replayed: false }
        },
      },
    })
    await daemon.start()
    try {
      const result = await daemon.sweepStale()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(result.reclaimed).toBe(1)
    } finally {
      await daemon.stop()
    }
    expect(db.updates).toBe(1)
    expect(dispatches).toBe(1)
    expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'restart_reclaim' })).toBe(1)
  })

  test('production-composed received not_d1 rows use the generic runner without tmux wake', async () => {
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runReceived(input) {
        calls.push(input)
      },
    }
    const metrics = new FakeMetrics()
    const tmux = new FakeTmux()
    let d1Dispatches = 0
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
      shirubeD1AutoReceive: {
        classify: () => ({ outcome: 'not_d1' }),
        async dispatch() { d1Dispatches += 1; return { code: 'unexpected', replayed: false } },
      },
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
    expect(d1Dispatches).toBe(0)
    expect(tmux.sentKeys).toEqual([])
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'received_runner_invoked',
    })).toBe(1)
    expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(0)
    expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
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

  test('exact-fenced phase handoff canaries bypass routing hold and use pending scheduler', async () => {
    const agentId = 'l2auditor'
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runPending(input) {
        calls.push(input)
      },
    }
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, {
        id: 121926,
        agent_id: agentId,
        status: 'pending',
        message_id: 'b7ef5baa-2562-45ae-a52d-1fca0503e4c3',
        payload: JSON.stringify({
          author_id: 'agent-com-dev',
          content: 'PR #773 L2 audit required',
          message_type: 'phase_handoff',
          source: 'cli-notify',
        }),
        claim_expires_at: null,
        created_at: new Date('2026-06-17T03:13:09.088Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-06-17T03:14:00.000Z'),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler,
      config: {
        codexRunnerEnabled: true,
        queueWorkFenceQueueIds: [121926],
        queueWorkFenceMessageIds: ['b7ef5baa-2562-45ae-a52d-1fca0503e4c3'],
        queueWorkFenceCreatedAfter: '2026-06-17T03:13:09.088Z',
      },
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: 121926,
        agent_id: agentId,
        status: 'pending',
        claim_expires_at: null,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(calls).toEqual([{ queueId: 121926, agentId }])
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'pending_routing_bypass',
      message_type: 'phase_handoff',
    })).toBe(1)
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'pending_runner_invoked',
    })).toBe(1)
    expect(metrics.countInc('state_daemon_wake_actions_total', {
      result: 'routing_non_actionable_held',
      message_type: 'phase_handoff',
    })).toBe(0)
  })

  test('non-fenced phase handoff rows remain routing-held before pending scheduler', async () => {
    const agentId = 'l2auditor'
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runPending(input) {
        calls.push(input)
      },
    }
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, {
        id: 121927,
        agent_id: agentId,
        status: 'pending',
        message_id: 'msg-121927',
        payload: JSON.stringify({
          author_id: 'agent-com-dev',
          content: 'unfenced phase handoff',
          message_type: 'phase_handoff',
          source: 'cli-notify',
        }),
        claim_expires_at: null,
        created_at: new Date('2026-06-17T03:13:09.088Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-06-17T03:14:00.000Z'),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler,
      config: { codexRunnerEnabled: true },
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'INSERT',
        id: 121927,
        agent_id: agentId,
        status: 'pending',
        claim_expires_at: null,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(calls).toEqual([])
    expect(metrics.countInc('state_daemon_wake_actions_total', {
      result: 'routing_non_actionable_held',
      message_type: 'phase_handoff',
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
    const row = {
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
    }
    const daemon = new StateDaemon({
      db: new PendingLlmDb(agentId, row),
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
      row.status = 'received'
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

  test('different queue rows for one agent are serialized until the active runner completes', async () => {
    const agentId = 'codex-audit'
    const calls: number[] = []
    let releaseFirst!: () => void
    let firstStartedResolve!: () => void
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve })
    const scheduler: QueueWorkScheduler = {
      async runPending(input) {
        calls.push(input.queueId)
        if (input.queueId === 492) {
          firstStartedResolve()
          await new Promise<void>((resolve) => { releaseFirst = resolve })
        }
      },
    }
    const rows = [492, 493].map((id) => ({
      id,
      agent_id: agentId,
      status: 'pending',
      message_id: `msg-${id}`,
      payload: JSON.stringify({ author_id: 'aun', content: `work ${id}`, message_type: 'instruction' }),
      claim_expires_at: null,
      created_at: new Date(`2026-05-08T00:00:0${id - 492}.000Z`),
      last_wake_attempt_at: null,
      last_heartbeat_at: null,
    }))
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new MultiPendingLlmDb(rows),
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics, alert: new FakeAlertSink(), queueWorkScheduler: scheduler,
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({ op: 'INSERT', id: 492, agent_id: agentId, status: 'pending', claim_expires_at: null })
      await firstStarted
      await daemon.__testHandleEvent({ op: 'INSERT', id: 493, agent_id: agentId, status: 'pending', claim_expires_at: null })
      expect(calls).toEqual([492])
      expect(metrics.countInc('state_daemon_queue_work_actions_total', {
        result: 'pending_runner_agent_busy_deferred',
      })).toBe(1)

      releaseFirst()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      await daemon.__testHandleEvent({ op: 'INSERT', id: 493, agent_id: agentId, status: 'pending', claim_expires_at: null })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(calls).toEqual([492, 493])
    } finally {
      releaseFirst?.()
      await daemon.stop()
    }
  })

  test('different agents retain parallel queue-work capacity', async () => {
    const calls: Array<{ queueId: number; agentId: string }> = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const scheduler: QueueWorkScheduler = {
      async runPending(input) {
        calls.push(input)
        await blocked
      },
    }
    const rows = [
      { id: 494, agent_id: 'codex-audit' },
      { id: 495, agent_id: 'adf-lead' },
    ].map(({ id, agent_id }) => ({
      id, agent_id, status: 'pending', message_id: `msg-${id}`,
      payload: JSON.stringify({ author_id: 'aun', content: `work ${id}`, message_type: 'instruction' }),
      claim_expires_at: null, created_at: new Date('2026-05-08T00:00:00.000Z'),
      last_wake_attempt_at: null, last_heartbeat_at: null,
    }))
    const daemon = new StateDaemon({
      db: new MultiPendingLlmDb(rows),
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics: new FakeMetrics(), alert: new FakeAlertSink(), queueWorkScheduler: scheduler,
    })

    await daemon.start()
    try {
      await Promise.all(rows.map((row) => daemon.__testHandleEvent({
        op: 'INSERT' as const, id: row.id, agent_id: row.agent_id,
        status: 'pending', claim_expires_at: null,
      })))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(calls).toEqual([
        { queueId: 494, agentId: 'codex-audit' },
        { queueId: 495, agentId: 'adf-lead' },
      ])
    } finally {
      release()
      await daemon.stop()
    }
  })

  test('live queue-work ids remain heartbeat-renewable past the generic claim max age', async () => {
    const agentId = 'adf-lead'
    let release!: () => void
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => { startedResolve = resolve })
    const row = {
      id: 496, agent_id: agentId, status: 'pending', message_id: 'msg-496',
      payload: JSON.stringify({ author_id: 'aun', content: 'long work', message_type: 'instruction' }),
      claim_expires_at: null, created_at: new Date('2026-05-08T00:00:00.000Z'),
      last_wake_attempt_at: null, last_heartbeat_at: null,
    }
    const db = new RecordingMultiPendingLlmDb([row])
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock: new FakeClock(),
      metrics: new FakeMetrics(), alert: new FakeAlertSink(),
      queueWorkScheduler: {
        async runPending() {
          startedResolve()
          await new Promise<void>((resolve) => { release = resolve })
        },
      },
      config: { activeClaimMaxAgeSec: 300 },
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({ op: 'INSERT', id: 496, agent_id: agentId, status: 'pending', claim_expires_at: null })
      await started
      await daemon.refreshClaims()
      const update = db.queries.find((query) => query.sql.includes('UPDATE message_queue mq'))
      const skipped = db.queries.find((query) => query.sql.includes('count(*)::int AS n'))
      expect(update?.sql).toContain('OR mq.id = ANY($4::bigint[])')
      expect(update?.sql).toContain("a.status IN ('online', 'busy')\n                 OR mq.id = ANY($4::bigint[])")
      expect(update?.params?.[3]).toEqual([496])
      expect(skipped?.sql).toContain('AND NOT (mq.id = ANY($3::bigint[]))')
      expect(skipped?.params?.[2]).toEqual([496])
    } finally {
      release?.()
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

  test('queue-work residue exclusion skips policy-preserved received rows before runner invocation', async () => {
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runReceived(input) {
        calls.push(input)
      },
    }
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db: new SingleRowDb({
        id: 121744,
        agent_id: 'secretary',
        status: 'received',
        message_id: '51647a24-0bfe-4efc-8cc8-2c795069bbf0',
        payload: JSON.stringify({
          content: 'incomplete canary residue',
          receive_claim: {
            source: 'state-daemon-queue-work-scheduler',
          },
        }),
        claim_expires_at: new Date('2026-06-15T00:00:30.000Z'),
        created_at: new Date('2026-06-15T10:51:34.000Z'),
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
        queueWorkResidueExcludedQueueIds: [121744],
      },
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'UPDATE',
        id: 121744,
        agent_id: 'secretary',
        status: 'received',
        claim_expires_at: '2026-06-15T00:00:30.000Z',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(calls).toEqual([])
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'queue_work_residue_excluded',
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
    expect(update?.sql).toContain('mq.payload NOT LIKE')
    expect(update?.sql).toContain('mq.payload NOT LIKE \'%"source":"state-daemon-d1-auto-receive"%\'')
    expect(update?.sql).toContain("a.status IN ('online', 'busy')")
    expect(update?.sql).toContain('mq.message_id = ANY')
    expect(update?.sql).toContain('mq.created_at >=')
    expect(skipped?.sql).toContain('mq.payload NOT LIKE \'%"source":"state-daemon-d1-auto-receive"%\'')
    expect(skipped?.sql).toContain('mq.message_id = ANY')
    expect(skipped?.sql).toContain('mq.created_at >=')
  })

  test('queue-work residue exclusion is applied to claim heartbeat refresh SQL', async () => {
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
        agentAllowlist: ['secretary'],
        queueWorkResidueExcludedQueueIds: [121744],
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
    expect(update?.sql).toContain('NOT (mq.id = ANY')
    expect(skipped?.sql).toContain('NOT (mq.id = ANY')
  })

  test('runner_error in_progress rows are reclaimed to pending with recovery evidence', async () => {
    const db = new RunnerErrorSweepDb({
      id: 493,
      agent_id: 'qa',
      status: 'in_progress',
      message_id: 'msg-493',
      payload: JSON.stringify({
        content: 'canary',
        runner_error: {
          invocation_source: 'state-daemon-queue-work-scheduler',
          message: 'adapter failed',
        },
      }),
      claim_expires_at: new Date('2026-05-08T00:05:00.000Z'),
      claimed_by: 'qa',
      claimed_at: new Date('2026-05-08T00:00:00.000Z'),
      created_at: new Date('2026-05-08T00:00:00.000Z'),
      last_wake_attempt_at: null,
      last_heartbeat_at: new Date('2026-05-08T00:00:10.000Z'),
    })
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-05-08T00:01:00.000Z'),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: {
        async runReceived() {},
      },
      config: { agentAllowlist: ['qa'] },
    })

    await daemon.start()
    try {
      const result = await daemon.sweepStale()

      expect(result.scanned).toBe(1)
      expect(result.reclaimed).toBe(1)
      expect(result.permanentlyFailed).toBe(0)
      expect(db.row.status).toBe('pending')
      expect(db.row.claimed_by).toBeNull()
      const payload = JSON.parse(db.row.payload)
      expect(payload.runner_error).toMatchObject({ message: 'adapter failed' })
      expect(payload.queue_work_runner_error_recovery).toMatchObject({
        attempts: 1,
        max_reclaims: 3,
        last_action: 'reclaimed',
        source: 'state-daemon-queue-work-scheduler',
      })
      expect(metrics.countInc('state_daemon_queue_work_actions_total', {
        result: 'runner_error_reclaimed',
      })).toBe(1)
    } finally {
      await daemon.stop()
    }
  })

  test('runner_error in_progress rows fail after the bounded reclaim cap', async () => {
    const db = new RunnerErrorSweepDb({
      id: 494,
      agent_id: 'qa',
      status: 'in_progress',
      message_id: 'msg-494',
      payload: JSON.stringify({
        content: 'canary',
        runner_error: {
          invocation_source: 'state-daemon-queue-work-scheduler',
          message: 'adapter failed again',
        },
        queue_work_runner_error_recovery: {
          attempts: 3,
          max_reclaims: 3,
          last_action: 'reclaimed',
        },
      }),
      claim_expires_at: new Date('2026-05-08T00:05:00.000Z'),
      claimed_by: 'qa',
      claimed_at: new Date('2026-05-08T00:00:00.000Z'),
      created_at: new Date('2026-05-08T00:00:00.000Z'),
      last_wake_attempt_at: null,
      last_heartbeat_at: new Date('2026-05-08T00:00:10.000Z'),
    })
    const alert = new FakeAlertSink()
    const metrics = new FakeMetrics()
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-05-08T00:01:00.000Z'),
      metrics,
      alert,
      queueWorkScheduler: {
        async runReceived() {},
      },
      config: { agentAllowlist: ['qa'] },
    })

    await daemon.start()
    try {
      const result = await daemon.sweepStale()

      expect(result.scanned).toBe(1)
      expect(result.reclaimed).toBe(0)
      expect(result.permanentlyFailed).toBe(1)
      expect(db.row.status).toBe('failed')
      expect(db.row.failed_reason).toBe('QUEUE_WORK_RUNNER_ERROR_RETRY_EXHAUSTED')
      const payload = JSON.parse(db.row.payload)
      expect(payload.queue_work_runner_error_recovery).toMatchObject({
        attempts: 3,
        max_reclaims: 3,
        last_action: 'failed',
        source: 'state-daemon-queue-work-scheduler',
        reason: 'QUEUE_WORK_RUNNER_ERROR_RETRY_EXHAUSTED',
      })
      expect(metrics.countInc('state_daemon_queue_work_actions_total', {
        result: 'runner_error_failed',
      })).toBe(1)
      expect(alert.contains('queue work runner_error exhausted for qa queue_id=494')).toBe(true)
    } finally {
      await daemon.stop()
    }
  })

  test('runner_error recovery is inert when queue-work scheduler is not configured', async () => {
    const db = new RunnerErrorSweepDb({
      id: 495,
      agent_id: 'qa',
      status: 'in_progress',
      message_id: 'msg-495',
      payload: JSON.stringify({
        content: 'canary',
        runner_error: { message: 'adapter failed' },
      }),
      claim_expires_at: new Date('2026-05-08T00:05:00.000Z'),
      claimed_by: 'qa',
      claimed_at: new Date('2026-05-08T00:00:00.000Z'),
      created_at: new Date('2026-05-08T00:00:00.000Z'),
      last_wake_attempt_at: null,
      last_heartbeat_at: new Date('2026-05-08T00:00:10.000Z'),
    })
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-05-08T00:01:00.000Z'),
      metrics: new FakeMetrics(),
      alert: new FakeAlertSink(),
      config: { agentAllowlist: ['qa'] },
    })

    await daemon.start()
    try {
      const result = await daemon.sweepStale()

      expect(result.scanned).toBe(0)
      expect(result.reclaimed).toBe(0)
      expect(result.permanentlyFailed).toBe(0)
      expect(db.row.status).toBe('in_progress')
      expect(db.updates).toEqual([])
    } finally {
      await daemon.stop()
    }
  })

  test('runner_error recovery does not reclaim policy-preserved residue rows', async () => {
    const db = new RunnerErrorSweepDb({
      id: 121744,
      agent_id: 'secretary',
      status: 'in_progress',
      message_id: '51647a24-0bfe-4efc-8cc8-2c795069bbf0',
      payload: JSON.stringify({
        content: 'incomplete canary residue',
        receive_claim: {
          source: 'state-daemon-queue-work-scheduler',
        },
        runner_error: {
          invocation_source: 'state-daemon-queue-work-scheduler',
          message: 'adapter failed',
        },
      }),
      claim_expires_at: new Date('2026-06-15T10:55:00.000Z'),
      claimed_by: 'secretary',
      claimed_at: new Date('2026-06-15T10:51:34.000Z'),
      created_at: new Date('2026-06-15T10:51:34.000Z'),
      last_wake_attempt_at: null,
      last_heartbeat_at: new Date('2026-06-15T10:52:00.000Z'),
    })
    const alert = new FakeAlertSink()
    const daemon = new StateDaemon({
      db,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-06-15T11:00:00.000Z'),
      metrics: new FakeMetrics(),
      alert,
      queueWorkScheduler: {
        async runReceived() {},
      },
      config: {
        agentAllowlist: ['secretary'],
        queueWorkResidueExcludedQueueIds: [121744],
      },
    })

    await daemon.start()
    try {
      const result = await daemon.sweepStale()

      expect(result.scanned).toBe(0)
      expect(result.reclaimed).toBe(0)
      expect(result.permanentlyFailed).toBe(0)
      expect(db.row.status).toBe('in_progress')
      expect(db.updates).toEqual([])
      expect(alert.alerts).toEqual([])
    } finally {
      await daemon.stop()
    }
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

  test('queue-work residue exclusion is applied to sweep fetch SQL', async () => {
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
        agentAllowlist: ['secretary'],
        queueWorkResidueExcludedQueueIds: [121744],
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
      .filter((query) => (
        query.sql.includes("mq.status='pending'")
        || query.sql.includes("mq.status IN ('received', 'in_progress')")
        || (query.sql.includes("mq.status='in_progress'") && query.sql.includes('runner_error'))
      ))
    expect(queueSelects.length).toBeGreaterThanOrEqual(4)
    for (const query of queueSelects) {
      expect(query.sql).toContain('NOT (mq.id = ANY')
    }
  })

  test('state-daemon loads residue exclusion ids from the governed policy file', () => {
    expect(loadQueueWorkResidueExcludedQueueIds({
      STATE_DAEMON_QUEUE_WORK_RESIDUE_EXCLUDE_QUEUE_IDS: '42',
      STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: join(REPO, 'config', 'queue-work-residue-policy.json'),
    } as NodeJS.ProcessEnv)).toEqual([42, 120138, 120245, 121744, 121839, 121873, 121876, 121919, 121924, 121938, 123851, 123940, 123945])
  })

  test('state-daemon fails closed on invalid manual residue exclusion ids', () => {
    expect(() => loadQueueWorkResidueExcludedQueueIds({
      STATE_DAEMON_QUEUE_WORK_RESIDUE_EXCLUDE_QUEUE_IDS: '121744,not-a-number',
    } as NodeJS.ProcessEnv)).toThrow('STATE_DAEMON_QUEUE_WORK_RESIDUE_EXCLUDE_QUEUE_IDS')
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
