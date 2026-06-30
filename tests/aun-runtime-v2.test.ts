import { describe, expect, test } from 'bun:test'
import {
  AUN_RUNTIME_V2_CLAIM_SOURCE,
  buildAunRuntimeV2Plan,
  runAunRuntimeV2,
} from '../core/aun-runtime-v2'
import {
  QUEUE_WORK_RESULT_VERSION,
  type LlmRuntimeAdapter,
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

class FakeAunRuntimeDb implements QueueWorkDb {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(public rows: any[]) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })
    const compact = sql.replace(/\s+/g, ' ').trim()
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(compact)) {
      return { rows: [], rowCount: 0 }
    }

    if (compact.includes('SELECT id, agent_id, message_id, payload, status')) {
      if (compact.includes('WHERE id = $1')) {
        const row = this.rows.find((item) => String(item.id) === String(params?.[0]))
        return row ? { rows: [{ ...row }] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }
      }

      const agentId = params?.[0]
      const messageParamIndex = compact.match(/message_id = \$(\d+)/)?.[1]
      const createdAfterParamIndex = compact.match(/created_at >= \$(\d+)/)?.[1]
      const messageId = messageParamIndex ? params?.[Number(messageParamIndex) - 1] : undefined
      const createdAfter = createdAfterParamIndex ? params?.[Number(createdAfterParamIndex) - 1] : undefined
      const row = this.rows
        .filter((item) => item.agent_id === agentId)
        .filter((item) => item.status === 'pending')
        .filter((item) => messageId === undefined || item.message_id === messageId)
        .filter((item) => createdAfter === undefined || Date.parse(item.created_at) >= Date.parse(String(createdAfter)))
        .sort((a, b) => {
          const priority = Number(b.priority ?? 0) - Number(a.priority ?? 0)
          if (priority !== 0) return priority
          return Date.parse(a.created_at) - Date.parse(b.created_at)
        })[0]
      return row ? { rows: [{ ...row }] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (compact.includes("SET status = 'received'")) {
      const row = this.rows.find((item) => (
        String(item.id) === String(params?.[0]) &&
        item.agent_id === params?.[2] &&
        item.status === 'pending'
      ))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'received'
      row.read_at = params?.[1]
      row.claimed_by = params?.[2]
      row.claimed_at = params?.[1]
      row.claim_expires_at = params?.[3]
      row.payload = params?.[4]
      return { rows: [{ ...row }] as T[], rowCount: 1 }
    }

    if (compact.includes("SET status = 'in_progress'")) {
      const row = this.rows.find((item) => String(item.id) === String(params?.[0]) && item.status === 'received')
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'in_progress'
      row.last_heartbeat_at = params?.[1]
      return { rows: [{ id: row.id }] as T[], rowCount: 1 }
    }

    if (compact.includes('last_heartbeat_at = $3')) {
      const row = this.rows.find((item) => (
        String(item.id) === String(params?.[0]) &&
        (item.status === 'in_progress' || item.status === 'done')
      ))
      if (!row) return { rows: [], rowCount: 0 }
      row.payload = params?.[1]
      row.last_heartbeat_at = params?.[2]
      return { rows: [{ id: row.id }] as T[], rowCount: 1 }
    }

    if (compact.includes("SET status = 'done'")) {
      const row = this.rows.find((item) => String(item.id) === String(params?.[0]) && item.status === 'in_progress')
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'done'
      row.done_at = params?.[1]
      row.payload = params?.[2]
      return { rows: [{ id: row.id }] as T[], rowCount: 1 }
    }

    if (compact.includes("SET status = 'replied'")) {
      const row = this.rows.find((item) => String(item.id) === String(params?.[0]) && item.status === 'done')
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'replied'
      row.replied_at = params?.[1]
      row.replied_with = params?.[2]
      row.payload = params?.[3]
      row.claimed_by = null
      row.claimed_at = null
      row.claim_expires_at = null
      return { rows: [{ id: row.id }] as T[], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake db: ${sql}`)
  }
}

function pendingKodamaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    agent_id: 'kodama',
    message_id: 'msg-kodama-1',
    status: 'pending',
    payload: JSON.stringify({
      channel_id: 'aun-v2-canary',
      thread_id: null,
      author_id: 'agent-com-dev',
      content: 'AUN runtime v2 canary',
      message_type: 'chat',
      reply_contract: {
        required: false,
      },
    }),
    priority: 0,
    created_at: '2026-06-18T00:00:00.000Z',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    ...overrides,
  }
}

function closeResult(overrides: Partial<QueueWorkResult> = {}): QueueWorkResult {
  return {
    schema_version: QUEUE_WORK_RESULT_VERSION,
    ok: true,
    summary: 'runtime v2 canary complete',
    reply: null,
    evidence: [
      'semantic_outcome=close',
      'outcome_reason=runtime_v2_canary_complete',
      'fake-runtime',
    ],
    next_action: 'close',
    ...overrides,
  }
}

describe('AUN runtime v2 planner', () => {
  test('defaults to kodama-only echo runtime with live activation disabled', () => {
    const plan = buildAunRuntimeV2Plan({
      agentId: 'kodama',
      env: {} as NodeJS.ProcessEnv,
    })

    expect(plan).toMatchObject({
      agent_id: 'kodama',
      allowed_agent_id: 'kodama',
      runtime: 'echo',
      claim_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
      invocation_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
      expected_claim_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
      live_activation: false,
    })
  })

  test('ignores env and imported allowed-agent override attempts', () => {
    const plan = buildAunRuntimeV2Plan({
      agentId: 'l2auditor',
      allowedAgentId: 'l2auditor',
      env: {
        AUN_RUNTIME_V2_ALLOWED_AGENT_ID: 'l2auditor',
      } as NodeJS.ProcessEnv,
    })

    expect(plan).toMatchObject({
      agent_id: 'l2auditor',
      allowed_agent_id: 'kodama',
    })
  })
})

describe('runAunRuntimeV2', () => {
  test('dry-run inspects the kodama candidate without mutation', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'kodama',
      dryRun: true,
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: true,
      dry_run: true,
      code: 'DRY_RUN',
      candidate: {
        queue_id: '1001',
        agent_id: 'kodama',
        status: 'pending',
      },
    })
    expect(db.rows[0].status).toBe('pending')
    expect(db.calls.some((call) => call.sql.includes('UPDATE message_queue'))).toBe(false)
  })

  test('rejects non-kodama agents before touching the DB', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'l2auditor',
      dryRun: true,
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'TARGET_AGENT_NOT_ALLOWED',
    })
    expect(db.calls).toEqual([])
    expect(db.rows[0].status).toBe('pending')
  })

  test('rejects non-kodama env override before touching the DB', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'l2auditor',
      dryRun: true,
      env: {
        AUN_RUNTIME_V2_ALLOWED_AGENT_ID: 'l2auditor',
      } as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'TARGET_AGENT_NOT_ALLOWED',
      plan: {
        allowed_agent_id: 'kodama',
      },
    })
    expect(db.calls).toEqual([])
    expect(db.rows[0].status).toBe('pending')
  })

  test('rejects non-kodama imported override before touching the DB', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        throw new Error('must not invoke adapter')
      },
    }

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'l2auditor',
      allowedAgentId: 'l2auditor',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      adapter,
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'TARGET_AGENT_NOT_ALLOWED',
      plan: {
        allowed_agent_id: 'kodama',
      },
    })
    expect(db.calls).toEqual([])
    expect(db.rows[0].status).toBe('pending')
  })

  test('honors exact queue/message/created_at fences before claim', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        throw new Error('must not invoke adapter')
      },
    }

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'other-message',
      createdAfter: '2026-06-18T00:00:00.000Z',
      adapter,
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'TARGET_QUEUE_MESSAGE_MISMATCH',
      candidate: {
        queue_id: '1001',
        status: 'pending',
      },
    })
    expect(db.rows[0].status).toBe('pending')
    expect(db.calls.some((call) => call.sql.includes("SET status = 'received'"))).toBe(false)
  })

  test('requires the exact fence before non-dry-run claim', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        throw new Error('must not invoke adapter')
      },
    }

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'kodama',
      queueId: '1001',
      adapter,
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'EXACT_FENCE_REQUIRED',
    })
    expect(db.calls).toEqual([])
    expect(db.rows[0].status).toBe('pending')
  })

  test('runs kodama pending -> received -> in_progress -> done -> replied', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])
    let seenEnvelope: QueueWorkEnvelope | null = null
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke(envelope) {
        seenEnvelope = envelope
        expect(db.rows[0].status).toBe('in_progress')
        return closeResult()
      },
    }

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      finalize: true,
      adapter,
      now: () => new Date('2026-06-18T00:01:00.000Z'),
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: true,
      dry_run: false,
      code: 'E2E_DONE',
      claimed: {
        queue_id: '1001',
        agent_id: 'kodama',
        status: 'received',
      },
      runner: {
        ok: true,
        code: 'DONE',
      },
      finalizer: {
        ok: true,
        code: 'CLOSED',
      },
    })
    expect(seenEnvelope).toMatchObject({
      queue_id: '1001',
      agent_id: 'kodama',
      reply_contract: {
        required: false,
      },
    })
    expect(db.rows[0].status).toBe('replied')
    expect(db.rows[0].claimed_by).toBeNull()
    const payload = JSON.parse(db.rows[0].payload)
    expect(payload.receive_claim).toMatchObject({
      mode: 'canonical-runtime-v2',
      source: AUN_RUNTIME_V2_CLAIM_SOURCE,
      runtime_version: 2,
      agent_id: 'kodama',
      queue_id: '1001',
    })
    expect(payload.runner_result).toMatchObject({
      runtime_id: 'fake-runtime',
      invocation_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
      next_action: 'close',
    })
    const sqls = db.calls.map((call) => call.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toContain('FOR UPDATE')
    expect(sqls[2]).toContain("SET status = 'received'")
    expect(sqls[3]).toBe('COMMIT')
  })

  test('adapter failures preserve typed runner_error evidence in_progress', async () => {
    const db = new FakeAunRuntimeDb([pendingKodamaRow()])
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        throw new Error('runtime unavailable')
      },
    }

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      adapter,
      now: () => new Date('2026-06-18T00:01:00.000Z'),
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'RUNNER_FAILED',
      runner: {
        ok: false,
        code: 'ADAPTER_ERROR',
      },
    })
    expect(db.rows[0].status).toBe('in_progress')
    expect(JSON.parse(db.rows[0].payload).runner_error).toMatchObject({
      code: 'ADAPTER_ERROR',
      detail: 'runtime unavailable',
      runtime_id: 'fake-runtime',
      invocation_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
    })
  })
})
