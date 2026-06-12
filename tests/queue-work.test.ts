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
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(public row: any | null) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
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
      return { rows: [{ ...this.row }] as T[], rowCount: 1 }
    }
    if (sql.includes("SET status = 'in_progress'")) {
      if (this.row && String(this.row.id) === String(params?.[0]) && this.row.status === 'received') {
        this.row.status = 'in_progress'
        this.row.last_heartbeat_at = params?.[1]
        return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('runner_error') || sql.includes('last_heartbeat_at = $3')) {
      if (this.row && String(this.row.id) === String(params?.[0]) && this.row.status === 'in_progress') {
        this.row.payload = params?.[1]
        this.row.last_heartbeat_at = params?.[2]
        return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("SET status = 'done'")) {
      if (this.row && String(this.row.id) === String(params?.[0]) && this.row.status === 'in_progress') {
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
    })
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
  })
})

describe('finalizeDoneQueueWork', () => {
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
})
