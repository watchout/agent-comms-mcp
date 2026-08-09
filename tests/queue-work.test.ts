import { describe, expect, test } from 'bun:test'
import {
  QUEUE_WORK_RESULT_VERSION,
  buildQueueWorkEnvelope,
  finalizeDoneQueueWork,
  runReceivedQueueWork,
  type LlmRuntimeAdapter,
  type QueueReplySender,
  type QueueWorkDb,
  type QueueWorkEnvelope,
  type QueueWorkResult,
  type QueueWorkWritebackSender,
} from '../core/queue-work'

const capabilities = {
  input: 'stdin_prompt',
  output: 'schema_json',
  supportsBareMode: true,
  supportsResume: false,
  supportsToolAllowlist: false,
  supportsSandbox: false,
  supportsUsageMetadata: false,
} as const

class FakeQueueDb implements QueueWorkDb {
  readonly dialect = 'postgres' as const
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    public row: any | null,
    private readonly databaseNow?: () => Date,
  ) {}

  private ownsFence(sql: string, params: unknown[] | undefined, ownerIndex: number, atIndex: number, nowIndex: number): boolean {
    if (!sql.includes(`claimed_by = $${ownerIndex + 1}`)) return true
    if (!this.row) return false
    const comparisonTime = sql.includes('claim_expires_at > clock_timestamp()') && this.databaseNow
      ? this.databaseNow().getTime()
      : Date.parse(String(params?.[nowIndex]))
    return (
      this.row.claimed_by === params?.[ownerIndex]
      && String(this.row.claimed_at) === String(params?.[atIndex])
      && Date.parse(String(this.row.claim_expires_at)) > comparisonTime
    )
  }

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    if (/^\s*SELECT id\s+FROM message_queue/.test(sql) && sql.includes('FOR UPDATE')) {
      if (
        this.row
        && String(this.row.id) === String(params?.[0])
        && (
          !sql.includes('claimed_by = $2')
          || (
            this.row.claimed_by === params?.[1]
            && String(this.row.claimed_at) === String(params?.[2])
          )
        )
      ) {
        return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('SELECT id, agent_id, message_id, payload, status')) {
      if (!this.row) return { rows: [], rowCount: 0 }
      if (sql.includes('WHERE id = $1') && String(this.row.id) !== String(params?.[0])) {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('WHERE agent_id = $1') && this.row.agent_id !== params?.[0]) {
        return { rows: [], rowCount: 0 }
      }
      return {
        rows: [{
          ...this.row,
          ...(sql.includes('CURRENT_TIMESTAMP AS database_now') ? {
            database_now: (this.databaseNow?.() ?? new Date('2026-05-21T01:00:00.000Z')).toISOString(),
          } : {}),
        }] as T[],
        rowCount: 1,
      }
    }
    if (sql.includes("SET status = 'in_progress'")) {
      const hasPayloadWrite = sql.includes('payload = $3')
      if (
        this.row
        && String(this.row.id) === String(params?.[0])
        && this.row.status === 'received'
        && this.ownsFence(sql, params, hasPayloadWrite ? 3 : 2, hasPayloadWrite ? 4 : 3, 1)
      ) {
        this.row.status = 'in_progress'
        this.row.last_heartbeat_at = params?.[1]
        if (hasPayloadWrite) this.row.payload = params?.[2]
        return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('runner_error') || sql.includes('last_heartbeat_at = $3')) {
      if (
        this.row
        && String(this.row.id) === String(params?.[0])
        && (this.row.status === 'in_progress' || this.row.status === 'done')
        && this.ownsFence(sql, params, 3, 4, 2)
      ) {
        this.row.payload = params?.[1]
        this.row.last_heartbeat_at = params?.[2]
        return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("SET status = 'done'")) {
      if (
        this.row
        && String(this.row.id) === String(params?.[0])
        && this.row.status === 'in_progress'
        && this.ownsFence(sql, params, 3, 4, 1)
      ) {
        this.row.status = 'done'
        this.row.done_at = params?.[1]
        this.row.payload = params?.[2]
        return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("SET status = 'replied'")) {
      if (this.row && String(this.row.id) === String(params?.[0]) && this.row.status === 'done') {
        this.row.status = 'replied'
        this.row.replied_at = params?.[1]
        this.row.replied_with = params?.[2]
        if (params?.[3] !== undefined) this.row.payload = params?.[3]
        this.row.claimed_by = null
        this.row.claimed_at = null
        this.row.claim_expires_at = null
        return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected SQL in fake db: ${sql}`)
  }
}

function receivedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    agent_id: 'codex-audit',
    message_id: 'msg-1',
    status: 'received',
    payload: JSON.stringify({
      channel_id: 'audit',
      thread_id: 'thread-1',
      author_id: 'codex-cto',
      content: 'Audit PR #489',
      message_type: 'chat',
    }),
    priority: 0,
    created_at: '2026-05-21T00:00:00.000Z',
    claimed_by: 'codex-audit',
    claimed_at: '2026-05-21T00:00:01.000Z',
    claim_expires_at: '2026-05-21T00:05:01.000Z',
    ...overrides,
  }
}

function githubBackedHandoffRow(overrides: Record<string, unknown> = {}) {
  return receivedRow({
    agent_id: 'l2auditor',
    payload: JSON.stringify({
      author_id: 'codex-cto',
      content: 'L2 audit required. GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/779',
      message_type: 'phase_handoff',
    }),
    ...overrides,
  })
}

function okResult(overrides: Partial<QueueWorkResult> = {}): QueueWorkResult {
  return {
    schema_version: QUEUE_WORK_RESULT_VERSION,
    ok: true,
    summary: 'completed',
    reply: 'LGTM',
    next_action: 'reply',
    evidence: [],
    ...overrides,
  }
}

describe('queue work envelope', () => {
  test('builds a runtime envelope that forbids queue-control tools', () => {
    const envelope = buildQueueWorkEnvelope(receivedRow())

    expect(envelope).toMatchObject({
      schema_version: 'queue_work_envelope_v1',
      queue_id: '42',
      message_id: 'msg-1',
      agent_id: 'codex-audit',
      channel: 'audit',
      thread_id: 'thread-1',
      requester: 'codex-cto',
      content: 'Audit PR #489',
      reply_contract: {
        required: true,
        reply_to: 'msg-1',
        mention: 'codex-cto',
      },
      runtime_contract: {
        do_not_call_next: true,
        do_not_call_inbox: true,
        return_schema: 'queue_work_result_v1',
      },
      handoff_contract: {
        kind: 'plain_queue_work',
        github_backed: false,
        posting_mode: 'none',
      },
    })
  })

  test('detects GitHub-backed phase handoff rows without echoing payload in planner-facing fields', () => {
    const envelope = buildQueueWorkEnvelope(githubBackedHandoffRow())

    expect(envelope.handoff_contract).toMatchObject({
      kind: 'github_backed_role_handoff',
      github_backed: true,
      required_writebacks: ['github_issue_comment'],
      posting_mode: 'none',
    })
    expect(envelope.handoff_contract.detected_from).toEqual(expect.arrayContaining([
      'message_type:phase_handoff',
      'github_url',
    ]))
  })
})

describe('runReceivedQueueWork', () => {
  test('advances received -> in_progress -> done and persists runner result', async () => {
    const db = new FakeQueueDb(receivedRow())
    let adapterEnvelope: QueueWorkEnvelope | null = null
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke(envelope) {
        adapterEnvelope = envelope
        expect(db.row.status).toBe('in_progress')
        return okResult()
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      invocationSource: 'state-daemon-queue-work-scheduler',
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: true, code: 'DONE', queue_id: '42' })
    expect(adapterEnvelope?.runtime_contract.do_not_call_next).toBe(true)
    expect(db.row.status).toBe('done')
    const payload = JSON.parse(db.row.payload)
    expect(payload.runner_result).toMatchObject({
      schema_version: 'queue_work_result_v1',
      ok: true,
      summary: 'completed',
      reply: 'LGTM',
      next_action: 'reply',
      runtime_id: 'fake-runtime',
      invocation_source: 'state-daemon-queue-work-scheduler',
      completed_at: '2026-05-21T01:00:00.000Z',
    })
  })

  test('expectedClaimSource leaves rows claimed by another path untouched (CLAIM_NOT_OWNED)', async () => {
    // Row claimed by a live TUI session: no receive_claim.source in payload.
    const db = new FakeQueueDb(receivedRow())
    let invoked = false
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        invoked = true
        return okResult()
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      invocationSource: 'state-daemon-queue-work-scheduler',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'CLAIM_NOT_OWNED',
      queue_id: '42',
      status: 'received',
    })
    expect(invoked).toBe(false)
    expect(db.row.status).toBe('received')
    expect(JSON.parse(db.row.payload).runner_result).toBeUndefined()
  })

  test('expectedClaimSource processes rows whose receive_claim.source matches', async () => {
    const db = new FakeQueueDb(receivedRow({
      payload: JSON.stringify({
        channel_id: 'audit',
        thread_id: 'thread-1',
        author_id: 'codex-cto',
        content: 'Audit PR #489',
        message_type: 'chat',
        receive_claim: {
          mode: 'targeted-receive',
          source: 'state-daemon-queue-work-scheduler',
          agent_id: 'codex-audit',
          queue_id: '42',
        },
      }),
    }))
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        return okResult()
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      invocationSource: 'state-daemon-queue-work-scheduler',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: true, code: 'DONE', queue_id: '42' })
    expect(db.row.status).toBe('done')
  })

  test('adapter failures leave the row in_progress with runner_error evidence', async () => {
    const db = new FakeQueueDb(receivedRow())
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        throw new Error('runtime unavailable')
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      invocationSource: 'state-daemon-queue-work-scheduler',
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'ADAPTER_ERROR',
      queue_id: '42',
    })
    expect(db.row.status).toBe('in_progress')
    expect(JSON.parse(db.row.payload).runner_error).toMatchObject({
      code: 'ADAPTER_ERROR',
      detail: 'runtime unavailable',
      runtime_id: 'fake-runtime',
      invocation_source: 'state-daemon-queue-work-scheduler',
    })
    expect(db.calls.find((call) => call.sql.includes('last_heartbeat_at = $3'))?.sql).toContain('RETURNING id')
  })

  test('non-ok result persistence returns its row for rows-length database adapters', async () => {
    class RowsLengthAdapterDb extends FakeQueueDb {
      override async query<T = any>(sql: string, params?: unknown[]) {
        const result = await super.query<T>(sql, params)
        return { rows: result.rows, rowCount: result.rows.length }
      }
    }
    const db = new RowsLengthAdapterDb(receivedRow({ claim_expires_at: '2026-05-21T02:00:00.000Z' }))
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'rows-length-runtime',
      capabilities,
      async invoke() {
        return { ...okResult(), ok: false, summary: 'audit found a blocker', next_action: 'retry' }
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      claimFence: {
        claimedBy: 'codex-audit',
        claimedAt: '2026-05-21T00:00:01.000Z',
      },
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: false, code: 'ADAPTER_RESULT_NOT_OK' })
    expect(JSON.parse(db.row.payload).runner_error).toMatchObject({
      code: 'ADAPTER_RESULT_NOT_OK',
      detail: 'audit found a blocker',
    })
  })

  test('exact claim fence prevents a stale runner from persisting done after ownership changes', async () => {
    const row = receivedRow({ claim_expires_at: '2026-05-21T02:00:00.000Z' })
    const db = new FakeQueueDb(row)
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fenced-runtime',
      capabilities,
      async invoke() {
        db.row.claimed_by = 'replacement-owner'
        db.row.claimed_at = '2026-05-21T01:00:30.000Z'
        return okResult()
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      claimFence: {
        claimedBy: 'codex-audit',
        claimedAt: '2026-05-21T00:00:01.000Z',
      },
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: false, code: 'CLAIM_OWNERSHIP_LOST' })
    expect(db.row.status).toBe('in_progress')
    expect(JSON.parse(db.row.payload).runner_result).toBeUndefined()
    const terminalLock = db.calls.findIndex((call) => (
      call.sql.includes('SELECT id') && call.sql.includes('claimed_by = $2')
    ))
    const terminalWrite = db.calls.findIndex((call) => call.sql.includes("SET status = 'done'"))
    expect(terminalLock).toBeGreaterThan(-1)
    expect(terminalWrite).toBe(-1)
    expect(JSON.parse(db.row.payload).runner_error).toBeUndefined()
  })

  test('same-agent expiry, reclaim, and re-receive cannot persist or finalize the stale result', async () => {
    const oldClaimedAt = '2026-05-21T00:00:01.000Z'
    const newClaimedAt = '2026-05-21T01:00:30.000Z'
    const row = receivedRow({
      payload: JSON.stringify({
        content: 'stale same-agent race',
        author_id: 'codex-cto',
        receive_claim: {
          source: 'state-daemon-queue-work-scheduler',
          agent_id: 'codex-audit',
          queue_id: '42',
        },
      }),
      claim_expires_at: '2026-05-21T02:00:00.000Z',
    })
    const db = new FakeQueueDb(row)
    let outbound = 0
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fenced-runtime',
      capabilities,
      async invoke() {
        // The old invocation is still running when the same agent receives a
        // newer incarnation of the exact row.
        db.row.status = 'in_progress'
        db.row.claimed_by = 'codex-audit'
        db.row.claimed_at = newClaimedAt
        db.row.claim_expires_at = '2026-05-21T03:00:00.000Z'
        return okResult()
      },
    }

    const runner = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      invocationSource: 'state-daemon-queue-work-scheduler',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      claimFence: { claimedBy: 'codex-audit', claimedAt: oldClaimedAt },
      requireClaimFence: true,
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })
    expect(runner).toMatchObject({ ok: false, code: 'CLAIM_OWNERSHIP_LOST' })
    expect(JSON.parse(db.row.payload).runner_result).toBeUndefined()

    const replySender: QueueReplySender = {
      async sendReply() {
        outbound += 1
        return { message_id: 'must-not-send' }
      },
    }
    const finalizer = db.row.status === 'done'
      ? await finalizeDoneQueueWork(db, { queueId: 42, replySender })
      : null
    expect(finalizer).toBeNull()
    expect(outbound).toBe(0)
    expect(db.row.status).toBe('in_progress')
    expect(db.row.claimed_at).toBe(newClaimedAt)
  })

  test('fenced runner persists pre-invocation runtime authority and exact result claim', async () => {
    const row = receivedRow({
      payload: JSON.stringify({
        content: 'fenced success',
        receive_claim: {
          source: 'state-daemon-queue-work-scheduler',
          agent_id: 'codex-audit',
          queue_id: '42',
        },
      }),
      claim_expires_at: '2026-05-21T02:00:00.000Z',
    })
    const db = new FakeQueueDb(row)
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fenced-runtime',
      capabilities,
      async invoke() { return okResult() },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      invocationSource: 'state-daemon-queue-work-scheduler',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      claimFence: {
        claimedBy: 'codex-audit',
        claimedAt: '2026-05-21T00:00:01.000Z',
      },
      requireClaimFence: true,
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: true, code: 'DONE' })
    const payload = JSON.parse(db.row.payload)
    expect(payload.queue_work_execution).toEqual({
      source: 'state-daemon-queue-work-scheduler',
      agent_id: 'codex-audit',
      queue_id: '42',
      runtime_id: 'fenced-runtime',
      claimed_by: 'codex-audit',
      claimed_at: '2026-05-21T00:00:01.000Z',
      started_at: '2026-05-21T01:00:00.000Z',
    })
    expect(payload.runner_result.claim_fence).toEqual({
      claimed_by: 'codex-audit',
      claimed_at: '2026-05-21T00:00:01.000Z',
    })
    expect(payload.runner_result.completed_at).toBe(db.row.done_at)
  })

  test('a new fenced execution archives and clears the prior runner error before invocation', async () => {
    const priorError = {
      code: 'ADAPTER_RESULT_NOT_OK',
      detail: 'prior attempt failed',
      runtime_id: 'fenced-runtime',
      invocation_source: 'state-daemon-queue-work-scheduler',
      failed_at: '2026-05-21T00:10:00.000Z',
      claim_fence: {
        claimed_by: 'codex-audit',
        claimed_at: '2026-05-21T00:00:01.000Z',
      },
    }
    const row = receivedRow({
      payload: JSON.stringify({
        content: 'retry exact work',
        receive_claim: {
          source: 'state-daemon-queue-work-scheduler',
          agent_id: 'codex-audit',
          queue_id: '42',
        },
        runner_error: priorError,
      }),
      claimed_at: '2026-05-21T00:30:01.000Z',
      claim_expires_at: '2026-05-21T02:00:00.000Z',
    })
    const db = new FakeQueueDb(row)
    let invocationPayload: Record<string, unknown> | null = null
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fenced-runtime',
      capabilities,
      async invoke() {
        invocationPayload = JSON.parse(db.row.payload)
        return okResult()
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      invocationSource: 'state-daemon-queue-work-scheduler',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      claimFence: {
        claimedBy: 'codex-audit',
        claimedAt: '2026-05-21T00:30:01.000Z',
      },
      requireClaimFence: true,
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: true, code: 'DONE' })
    expect(invocationPayload?.runner_error).toBeUndefined()
    expect(invocationPayload?.queue_work_runner_error_history).toEqual([
      expect.objectContaining({
        ...priorError,
        archived_at: '2026-05-21T01:00:00.000Z',
        replaced_by_claim_fence: {
          claimed_by: 'codex-audit',
          claimed_at: '2026-05-21T00:30:01.000Z',
        },
      }),
    ])
  })

  test('exact claim fence prevents stale runner_error persistence after ownership changes', async () => {
    const row = receivedRow({ claim_expires_at: '2026-05-21T02:00:00.000Z' })
    const db = new FakeQueueDb(row)
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fenced-runtime',
      capabilities,
      async invoke() {
        db.row.claimed_by = 'replacement-owner'
        db.row.claimed_at = '2026-05-21T01:00:30.000Z'
        throw new Error('stale failure')
      },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      claimFence: {
        claimedBy: 'codex-audit',
        claimedAt: '2026-05-21T00:00:01.000Z',
      },
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: false, code: 'CLAIM_OWNERSHIP_LOST' })
    expect(JSON.parse(db.row.payload).runner_error).toBeUndefined()
  })

  test('claim expiry during terminal persistence prevents a stale done write', async () => {
    const startedAt = new Date('2026-05-21T01:00:00.000Z')
    let databaseNow = startedAt
    const row = receivedRow({ claim_expires_at: '2026-05-21T01:00:00.100Z' })
    class ExpiringDoneDb extends FakeQueueDb {
      override async query<T = any>(sql: string, params?: unknown[]) {
        if (sql.includes("SET status = 'done'")) {
          databaseNow = new Date('2026-05-21T01:00:00.200Z')
        }
        return super.query<T>(sql, params)
      }
    }
    const db = new ExpiringDoneDb(row, () => databaseNow)
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fenced-runtime',
      capabilities,
      async invoke() { return okResult() },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      claimFence: {
        claimedBy: 'codex-audit',
        claimedAt: '2026-05-21T00:00:01.000Z',
      },
      now: () => startedAt,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'CLAIM_OWNERSHIP_LOST' })
    expect(db.row.status).toBe('in_progress')
    expect(JSON.parse(db.row.payload).runner_result).toBeUndefined()
    const terminalLock = db.calls.findIndex((call) => (
      call.sql.includes('SELECT id') && call.sql.includes('claimed_by = $2')
    ))
    const terminalWrite = db.calls.findIndex((call) => call.sql.includes("SET status = 'done'"))
    expect(terminalLock).toBeGreaterThan(-1)
    expect(terminalWrite).toBeGreaterThan(terminalLock)
  })

  test('claim expiry during error persistence prevents a stale runner_error write', async () => {
    const startedAt = new Date('2026-05-21T01:00:00.000Z')
    let databaseNow = startedAt
    const row = receivedRow({ claim_expires_at: '2026-05-21T01:00:00.100Z' })
    class ExpiringErrorDb extends FakeQueueDb {
      override async query<T = any>(sql: string, params?: unknown[]) {
        if (sql.includes('last_heartbeat_at = $3')) {
          databaseNow = new Date('2026-05-21T01:00:00.200Z')
        }
        return super.query<T>(sql, params)
      }
    }
    const db = new ExpiringErrorDb(row, () => databaseNow)
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fenced-runtime',
      capabilities,
      async invoke() { throw new Error('late failure') },
    }

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      claimFence: {
        claimedBy: 'codex-audit',
        claimedAt: '2026-05-21T00:00:01.000Z',
      },
      now: () => startedAt,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'CLAIM_OWNERSHIP_LOST' })
    expect(db.row.status).toBe('in_progress')
    expect(JSON.parse(db.row.payload).runner_error).toBeUndefined()
    const errorLock = db.calls.findIndex((call) => (
      call.sql.includes('SELECT id') && call.sql.includes('claimed_by = $2')
    ))
    const errorWrite = db.calls.findIndex((call) => call.sql.includes('last_heartbeat_at = $3'))
    expect(errorLock).toBeGreaterThan(-1)
    expect(errorWrite).toBeGreaterThan(errorLock)
  })

  test('abort is a typed non-terminal outcome with no done or runner_error write', async () => {
    const db = new FakeQueueDb(receivedRow())
    const controller = new AbortController()
    let settled = 0
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'abortable-runtime',
      capabilities,
      supportsAbort: true,
      execution_timeout_ms: 100,
      async invoke() {
        return await new Promise<QueueWorkResult>(() => {})
      },
    }
    setTimeout(() => controller.abort(new Error('lease lost')), 1)

    const outcome = await runReceivedQueueWork(db, {
      queueId: 42,
      adapter,
      signal: controller.signal,
      async onInvocationSettled() { settled += 1 },
      now: () => new Date('2026-05-21T01:00:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'EXECUTION_ABORTED',
      detail: 'lease lost',
    })
    expect(settled).toBe(1)
    expect(db.row.status).toBe('in_progress')
    expect(JSON.parse(db.row.payload).runner_result).toBeUndefined()
    expect(JSON.parse(db.row.payload).runner_error).toBeUndefined()
  })
})

describe('finalizeDoneQueueWork', () => {
  test('claim/result fence blocks outbound and close for a stale same-agent result', async () => {
    const oldClaimedAt = '2026-05-21T00:00:01.000Z'
    const newClaimedAt = '2026-05-21T01:00:30.000Z'
    const completedAt = '2026-05-21T01:01:00.000Z'
    const result = {
      ...okResult(),
      runtime_id: 'fenced-runtime',
      invocation_source: 'state-daemon-queue-work-scheduler',
      completed_at: completedAt,
      claim_fence: {
        claimed_by: 'codex-audit',
        claimed_at: oldClaimedAt,
      },
    }
    const row = receivedRow({
      status: 'done',
      claimed_by: 'codex-audit',
      claimed_at: newClaimedAt,
      claim_expires_at: '2026-05-21T02:00:00.000Z',
      done_at: completedAt,
      payload: JSON.stringify({
        content: 'stale result must not escape',
        receive_claim: {
          source: 'state-daemon-queue-work-scheduler',
          agent_id: 'codex-audit',
          queue_id: '42',
        },
        queue_work_execution: {
          source: 'state-daemon-queue-work-scheduler',
          agent_id: 'codex-audit',
          queue_id: '42',
          runtime_id: 'fenced-runtime',
          claimed_by: 'codex-audit',
          claimed_at: oldClaimedAt,
          started_at: '2026-05-21T00:30:00.000Z',
        },
        runner_result: result,
      }),
    })
    const db = new FakeQueueDb(row, () => new Date('2026-05-21T01:02:00.000Z'))
    let outbound = 0
    const replySender: QueueReplySender = {
      async sendReply() {
        outbound += 1
        return { message_id: 'must-not-send' }
      },
    }

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      replySender,
      claimResultFence: {
        expectedClaimSource: 'state-daemon-queue-work-scheduler',
        expectedRuntimeId: 'fenced-runtime',
      },
      now: () => new Date('2026-05-21T01:02:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: false, code: 'TERMINAL_EVIDENCE_INVALID' })
    expect(outcome.detail).toContain('claimed_at')
    expect(outbound).toBe(0)
    expect(db.row.status).toBe('done')
    expect(db.calls.some((call) => call.sql.includes("SET status = 'replied'"))).toBe(false)
  })

  test('D1 done rows cannot close without an exact completed receipt DB fence', async () => {
    const row = receivedRow({
      status: 'done',
      payload: JSON.stringify({
        content: 'D1 protected task',
        shirube_v4_d1: {
          authorization: { authorization_digest: 'a'.repeat(64) },
        },
        runner_result: okResult({ reply: undefined, next_action: 'close' }),
      }),
    })
    const db = new FakeQueueDb(row)

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      now: () => new Date('2026-07-21T09:00:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'D1_COMPLETION_RECEIPT_REQUIRED',
      queue_id: '42',
    })
    expect(db.row.status).toBe('done')
    expect(JSON.parse(db.row.payload).finalizer_error).toMatchObject({
      code: 'D1_COMPLETION_RECEIPT_REQUIRED',
    })
    expect(db.calls.some((call) => call.sql.includes("SET status = 'replied'"))).toBe(false)
  })

  test('holds the finalize transaction across select, reply send, and replied update', async () => {
    const row = receivedRow({
      status: 'done',
      payload: JSON.stringify({
        channel_id: 'audit',
        author_id: 'codex-cto',
        content: 'Audit PR #489',
        runner_result: okResult({ reply: 'L3 LGTM', next_action: 'reply' }),
      }),
    })
    const events: string[] = []
    const db = new FakeQueueDb(row)
    const query = db.query.bind(db)
    db.query = async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        events.push(sql)
      } else if (sql.includes('FOR UPDATE')) {
        events.push('SELECT_FOR_UPDATE')
      } else if (sql.includes("SET status = 'replied'")) {
        events.push('UPDATE_REPLIED')
      }
      return query(sql, params)
    }
    const replySender: QueueReplySender = {
      async sendReply() {
        events.push('SEND_REPLY')
        return { message_id: 'reply-1' }
      },
    }

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      replySender,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({ ok: true, code: 'REPLIED' })
    expect(events).toEqual([
      'BEGIN',
      'SELECT_FOR_UPDATE',
      'SEND_REPLY',
      'UPDATE_REPLIED',
      'COMMIT',
    ])
    expect(events).not.toContain('ROLLBACK')
  })

  test('releases the row lock for a sender-owned close and verifies exact reply readback', async () => {
    const row = receivedRow({
      status: 'done',
      payload: JSON.stringify({
        channel_id: 'audit',
        author_id: 'codex-cto',
        content: 'Audit PR #489',
        runner_result: okResult({ reply: 'L3 LGTM', next_action: 'reply' }),
      }),
    })
    const events: string[] = []
    const db = new FakeQueueDb(row)
    const query = db.query.bind(db)
    db.query = async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        events.push(sql)
      } else if (sql.includes('FOR UPDATE')) {
        events.push('SELECT_FOR_UPDATE')
      }
      return query(sql, params)
    }
    const replySender: QueueReplySender = {
      queue_close_mode: 'sender',
      async sendReply() {
        events.push('SEND_REPLY')
        expect(events.at(-2)).toBe('COMMIT')
        db.row.status = 'replied'
        db.row.replied_with = 'reply-1'
        db.row.claimed_by = null
        db.row.claimed_at = null
        db.row.claim_expires_at = null
        return { message_id: 'reply-1', queue_closed: true }
      },
    }

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      replySender,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: true,
      code: 'REPLIED',
      queue_id: '42',
      replied_with: 'reply-1',
    })
    expect(events).toEqual([
      'BEGIN',
      'SELECT_FOR_UPDATE',
      'COMMIT',
      'SEND_REPLY',
      'BEGIN',
      'SELECT_FOR_UPDATE',
      'COMMIT',
    ])
  })

  test('sends the stored reply and closes done rows as replied', async () => {
    const row = receivedRow({
      status: 'done',
      payload: JSON.stringify({
        channel_id: 'audit',
        author_id: 'codex-cto',
        content: 'Audit PR #489',
        runner_result: okResult({ reply: 'L3 LGTM', next_action: 'reply' }),
      }),
    })
    const db = new FakeQueueDb(row)
    const sent: Array<{ queue_id: string; content: string; mention: string | null }> = []
    const replySender: QueueReplySender = {
      async sendReply(input) {
        sent.push({
          queue_id: input.queue_id,
          content: input.content,
          mention: input.mention,
        })
        return { message_id: 'reply-1' }
      },
    }

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      replySender,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: true,
      code: 'REPLIED',
      queue_id: '42',
      replied_with: 'reply-1',
    })
    expect(sent).toEqual([{ queue_id: '42', content: 'L3 LGTM', mention: 'codex-cto' }])
    expect(db.row.status).toBe('replied')
    expect(db.row.claimed_by).toBeNull()
  })

  test('rolls back without sending when a reply result has no reply sender', async () => {
    const row = receivedRow({
      status: 'done',
      payload: JSON.stringify({
        channel_id: 'audit',
        author_id: 'codex-cto',
        content: 'Audit PR #489',
        runner_result: okResult({ reply: 'L3 LGTM', next_action: 'reply' }),
      }),
    })
    const db = new FakeQueueDb(row)

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'MISSING_REPLY_SENDER',
      queue_id: '42',
    })
    const sqls = db.calls.map((call) => call.sql)
    expect(sqls).toHaveLength(3)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toContain('FOR UPDATE')
    expect(sqls[2]).toBe('ROLLBACK')
    expect(db.row.status).toBe('done')
  })

  test('closes non-reply results without calling a reply sender', async () => {
    const row = receivedRow({
      status: 'done',
      payload: JSON.stringify({
        content: 'internal task',
        runner_result: okResult({ reply: undefined, next_action: 'close' }),
      }),
    })
    const db = new FakeQueueDb(row)

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: true,
      code: 'CLOSED',
      queue_id: '42',
      replied_with: null,
    })
    expect(db.row.status).toBe('replied')
  })

  test('GitHub-backed handoff results require a structured mediated writeback', async () => {
    const row = githubBackedHandoffRow({
      status: 'done',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: 'L2 audit required. GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/779',
        message_type: 'phase_handoff',
        runner_result: okResult({ reply: null, next_action: 'close' }),
      }),
    })
    const db = new FakeQueueDb(row)

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'MISSING_WRITEBACK',
      queue_id: '42',
    })
    expect(db.row.status).toBe('done')
    expect(JSON.parse(db.row.payload).finalizer_error).toMatchObject({
      code: 'MISSING_WRITEBACK',
    })
  })

  test('GitHub-backed handoff finalization delegates posting to a mediated sender', async () => {
    const writeback = {
      mode: 'github_issue_comment' as const,
      repo: 'watchout/agent-comms-mcp',
      issue_number: 779,
      body: [
        '<!-- aun:l2-audit/v1 -->',
        'repo: watchout/agent-comms-mcp',
        'pr: 779',
        'role: l2auditor',
        'source_queue_id: 42',
        'source_message_id: msg-1',
        'verdict: PASS',
      ].join('\n'),
      evidence: ['exact_head:abc123'],
    }
    const row = githubBackedHandoffRow({
      status: 'done',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: 'L2 audit required. GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/779',
        message_type: 'phase_handoff',
        runner_result: okResult({ reply: null, next_action: 'close', writeback }),
      }),
    })
    const db = new FakeQueueDb(row)
    const posted: unknown[] = []
    const writebackSender: QueueWorkWritebackSender = {
      async sendWriteback(input) {
        posted.push(input)
        return {
          posted_with: 'https://github.com/watchout/agent-comms-mcp/pull/779#issuecomment-1',
          body_sha256: 'a'.repeat(64),
        }
      },
    }

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      writebackSender,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: true,
      code: 'WRITEBACK_POSTED',
      queue_id: '42',
      replied_with: 'https://github.com/watchout/agent-comms-mcp/pull/779#issuecomment-1',
      writeback_posted_with: 'https://github.com/watchout/agent-comms-mcp/pull/779#issuecomment-1',
    })
    expect(posted).toEqual([
      expect.objectContaining({
        queue_id: '42',
        agent_id: 'l2auditor',
        handoff_contract: expect.objectContaining({ kind: 'github_backed_role_handoff' }),
        writeback,
        runtime_result_summary: expect.objectContaining({ summary: 'completed', next_action: 'close' }),
      }),
    ])
    expect(db.row.status).toBe('replied')
    expect(JSON.parse(db.row.payload).writeback_result).toMatchObject({
      posted_with: 'https://github.com/watchout/agent-comms-mcp/pull/779#issuecomment-1',
      body_sha256: 'a'.repeat(64),
    })
  })

  test('GitHub-backed handoff finalization fails closed when mediated sender returns no posted URL', async () => {
    const writeback = {
      mode: 'github_issue_comment' as const,
      repo: 'watchout/agent-comms-mcp',
      issue_number: 779,
      body: [
        '<!-- aun:l2-audit/v1 -->',
        'repo: watchout/agent-comms-mcp',
        'pr: 779',
        'role: l2auditor',
        'source_queue_id: 42',
        'source_message_id: msg-1',
        'verdict: PASS',
      ].join('\n'),
      evidence: ['exact_head:abc123'],
    }
    const row = githubBackedHandoffRow({
      status: 'done',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: 'L2 audit required. GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/779',
        message_type: 'phase_handoff',
        runner_result: okResult({ reply: null, next_action: 'close', writeback }),
      }),
    })
    const db = new FakeQueueDb(row)
    const writebackSender: QueueWorkWritebackSender = {
      async sendWriteback() {
        return {
          posted_with: null,
          body_sha256: 'a'.repeat(64),
        }
      },
    }

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      writebackSender,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'WRITEBACK_FAILED',
      queue_id: '42',
      detail: 'mediated writeback sender did not return posted_with',
    })
    expect(db.row.status).toBe('done')
    const payload = JSON.parse(db.row.payload)
    expect(payload.writeback_result).toBeUndefined()
    expect(payload.finalizer_error).toMatchObject({
      code: 'WRITEBACK_FAILED',
      detail: 'mediated writeback sender did not return posted_with',
    })
  })

  test('does not terminal-close retry results until retry semantics exist', async () => {
    const row = receivedRow({
      status: 'done',
      payload: JSON.stringify({
        channel_id: 'audit',
        author_id: 'codex-cto',
        content: 'Audit PR #489',
        runner_result: okResult({
          ok: false,
          reply: null,
          next_action: 'retry',
          summary: 'runtime could not complete safely',
        }),
      }),
    })
    const db = new FakeQueueDb(row)
    let sendCount = 0
    const replySender: QueueReplySender = {
      async sendReply() {
        sendCount += 1
        return { message_id: 'reply-should-not-exist' }
      },
    }

    const outcome = await finalizeDoneQueueWork(db, {
      queueId: 42,
      replySender,
      now: () => new Date('2026-05-21T01:05:00.000Z'),
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'RETRY_NOT_IMPLEMENTED',
      queue_id: '42',
    })
    expect(sendCount).toBe(0)
    expect(db.calls.map((call) => call.sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      'ROLLBACK',
    ])
    expect(db.row.status).toBe('done')
    expect(db.row.replied_with).toBeUndefined()
  })
})
