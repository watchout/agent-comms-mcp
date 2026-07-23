import { describe, expect, test } from 'bun:test'
import {
  AUN_RUNTIME_V2_CLAIM_SOURCE,
  buildAunRuntimeV2Plan,
  computeAunRuntimeV2ExecutionHeartbeatMs,
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
  renewalMode: 'ok' | 'zero' | 'error' = 'ok'
  renewalCount = 0

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

    if (compact.includes('SET claim_expires_at = $5')) {
      this.renewalCount += 1
      if (this.renewalMode === 'error') throw new Error('heartbeat db unavailable')
      if (this.renewalMode === 'zero') return { rows: [], rowCount: 0 }
      const row = this.rows.find((item) => (
        String(item.id) === String(params?.[0])
        && item.agent_id === params?.[1]
        && item.claimed_by === params?.[2]
        && String(item.claimed_at) === String(params?.[5])
        && (item.status === 'received' || item.status === 'in_progress')
        && Date.parse(String(item.claim_expires_at)) > Date.parse(String(params?.[3]))
      ))
      if (!row) return { rows: [], rowCount: 0 }
      row.claim_expires_at = params?.[4]
      row.last_heartbeat_at = params?.[3]
      return { rows: [{ id: row.id }] as T[], rowCount: 1 }
    }

    if (compact.includes("SET status = 'in_progress'")) {
      const row = this.rows.find((item) => (
        String(item.id) === String(params?.[0])
        && item.status === 'received'
        && (
          !compact.includes('claimed_by = $3')
          || (
            item.claimed_by === params?.[2]
            && String(item.claimed_at) === String(params?.[3])
            && Date.parse(String(item.claim_expires_at)) > Date.parse(String(params?.[1]))
          )
        )
      ))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'in_progress'
      row.last_heartbeat_at = params?.[1]
      return { rows: [{ id: row.id }] as T[], rowCount: 1 }
    }

    if (compact.includes('last_heartbeat_at = $3')) {
      const row = this.rows.find((item) => (
        String(item.id) === String(params?.[0]) &&
        (item.status === 'in_progress' || item.status === 'done')
        && (
          !compact.includes('claimed_by = $4')
          || (
            item.claimed_by === params?.[3]
            && String(item.claimed_at) === String(params?.[4])
            && Date.parse(String(item.claim_expires_at)) > Date.parse(String(params?.[2]))
          )
        )
      ))
      if (!row) return { rows: [], rowCount: 0 }
      row.payload = params?.[1]
      row.last_heartbeat_at = params?.[2]
      return { rows: [{ id: row.id }] as T[], rowCount: 1 }
    }

    if (compact.includes("SET status = 'done'")) {
      const row = this.rows.find((item) => (
        String(item.id) === String(params?.[0])
        && item.status === 'in_progress'
        && (
          !compact.includes('claimed_by = $4')
          || (
            item.claimed_by === params?.[3]
            && String(item.claimed_at) === String(params?.[4])
            && Date.parse(String(item.claim_expires_at)) > Date.parse(String(params?.[1]))
          )
        )
      ))
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

function pendingRuntimeRow(agentId = 'kodama', overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    agent_id: agentId,
    message_id: `msg-${agentId}-1`,
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

function pendingKodamaRow(overrides: Record<string, unknown> = {}) {
  return pendingRuntimeRow('kodama', overrides)
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

function fakeD1Runtime() {
  return {
    policy: { enabled: true, kill_switch: false },
    allowsAgent(agentId: string | null) { return agentId === 'dev-001' },
    isEnrolledAgent(agentId: string | null) { return agentId === 'dev-001' },
    async prepareFinalizationSenders() {
      throw new Error('finalization intentionally stopped after runner proof')
    },
  } as any
}

describe('AUN runtime v2 planner', () => {
  test('execution heartbeat cadence stays positive and below half the claim TTL', () => {
    expect(computeAunRuntimeV2ExecutionHeartbeatMs(1)).toBe(333)
    expect(computeAunRuntimeV2ExecutionHeartbeatMs(30)).toBe(10_000)
    expect(computeAunRuntimeV2ExecutionHeartbeatMs(120)).toBe(10_000)
  })

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
      policy_id: 'aun-runtime-v2-pr-a-allowlist',
      policy_version: '2026-06-18.pr-a',
      policy_source: 'watchout/agent-comms-mcp#792',
      policy_agent_mode: 'live',
      live_agent_ids: ['kodama'],
    })
    expect(plan.allowed_agent_ids).toContain('arc')
    expect(plan.allowed_agent_ids).toContain('agent-com-dev')
    expect(plan.allowed_agent_ids).not.toContain('l2auditor')
    expect(plan.allowed_agent_ids).not.toContain('devauditor')
  })

  test('allows policy-listed non-kodama dry-run planning but marks it dry-run only', () => {
    const plan = buildAunRuntimeV2Plan({
      agentId: 'arc',
      env: {
        AUN_RUNTIME_V2_ALLOWED_AGENT_ID: 'l2auditor',
      } as NodeJS.ProcessEnv,
    })

    expect(plan).toMatchObject({
      agent_id: 'arc',
      allowed_agent_id: 'kodama',
      policy_id: 'aun-runtime-v2-pr-a-allowlist',
      policy_agent_mode: 'dry_run',
      live_agent_ids: ['kodama'],
    })
    expect(plan.allowed_agent_ids).toContain('arc')
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
      policy_agent_mode: 'not_allowed',
    })
    expect(plan.allowed_agent_ids).not.toContain('l2auditor')
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

  test('dry-runs a policy-listed non-kodama candidate without mutation', async () => {
    const db = new FakeAunRuntimeDb([pendingRuntimeRow('arc')])

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'arc',
      dryRun: true,
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: true,
      dry_run: true,
      code: 'DRY_RUN',
      plan: {
        agent_id: 'arc',
        policy_agent_mode: 'dry_run',
        live_agent_ids: ['kodama'],
      },
      candidate: {
        queue_id: '1001',
        agent_id: 'arc',
        status: 'pending',
      },
    })
    expect(db.rows[0].status).toBe('pending')
    expect(db.calls.some((call) => call.sql.includes('UPDATE message_queue'))).toBe(false)
  })

  test('rejects policy-listed non-kodama live attempts before touching the DB', async () => {
    const db = new FakeAunRuntimeDb([pendingRuntimeRow('codex-cto')])
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'fake-runtime',
      capabilities,
      async invoke() {
        throw new Error('must not invoke adapter')
      },
    }

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'codex-cto',
      queueId: '1001',
      messageId: 'msg-codex-cto-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      adapter,
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      dry_run: false,
      code: 'TARGET_AGENT_NOT_LIVE_CAPABLE',
      plan: {
        agent_id: 'codex-cto',
        policy_agent_mode: 'dry_run',
        live_agent_ids: ['kodama'],
      },
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

  test('live D1 execution renews its exact claim beyond TTL independently of agent status', async () => {
    const db = new FakeAunRuntimeDb([pendingRuntimeRow('dev-001')])
    const adapter: LlmRuntimeAdapter = {
      runtime_id: 'delayed-runtime',
      capabilities,
      execution_timeout_ms: 2_000,
      supportsAbort: true,
      async invoke(_envelope, opts) {
        expect(opts?.signal).toBeDefined()
        await new Promise((resolve) => setTimeout(resolve, 1_100))
        return closeResult()
      },
    }

    const outcome = await runAunRuntimeV2(db, {
      agentId: 'dev-001',
      queueId: '1001',
      messageId: 'msg-dev-001-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      claimTtlSeconds: 1,
      finalize: true,
      adapter,
      d1Runtime: fakeD1Runtime(),
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'D1_FINALIZATION_FENCE_FAILED',
      runner: { ok: true, code: 'DONE' },
    })
    expect(db.renewalCount).toBeGreaterThanOrEqual(4)
    expect(db.rows[0].status).toBe('done')
    expect(JSON.parse(db.rows[0].payload).runner_result).toBeDefined()
  })

  test('live D1 zero-row heartbeat aborts before invocation and writes no terminal evidence', async () => {
    const db = new FakeAunRuntimeDb([pendingRuntimeRow('dev-001')])
    db.renewalMode = 'zero'
    let invoked = 0
    const outcome = await runAunRuntimeV2(db, {
      agentId: 'dev-001',
      queueId: '1001',
      messageId: 'msg-dev-001-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      claimTtlSeconds: 1,
      finalize: true,
      adapter: {
        runtime_id: 'must-not-run', capabilities,
        execution_timeout_ms: 1_000, supportsAbort: true,
        async invoke() { invoked += 1; return closeResult() },
      },
      d1Runtime: fakeD1Runtime(),
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'RUNNER_FAILED',
      runner: { ok: false, code: 'EXECUTION_ABORTED', detail: 'D1_EXECUTION_CLAIM_OWNERSHIP_LOST' },
    })
    expect(invoked).toBe(0)
    expect(db.rows[0].status).toBe('received')
    expect(JSON.parse(db.rows[0].payload).runner_result).toBeUndefined()
    expect(JSON.parse(db.rows[0].payload).runner_error).toBeUndefined()
  })

  test('live D1 heartbeat query failure aborts fail-closed before invocation', async () => {
    const db = new FakeAunRuntimeDb([pendingRuntimeRow('dev-001')])
    db.renewalMode = 'error'
    let invoked = 0
    const outcome = await runAunRuntimeV2(db, {
      agentId: 'dev-001',
      queueId: '1001',
      messageId: 'msg-dev-001-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      claimTtlSeconds: 1,
      finalize: true,
      adapter: {
        runtime_id: 'must-not-run', capabilities,
        execution_timeout_ms: 1_000, supportsAbort: true,
        async invoke() { invoked += 1; return closeResult() },
      },
      d1Runtime: fakeD1Runtime(),
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'RUNNER_FAILED',
      runner: { ok: false, code: 'EXECUTION_ABORTED' },
    })
    expect(outcome.ok ? '' : outcome.runner?.detail).toContain('D1_EXECUTION_HEARTBEAT_FAILED')
    expect(invoked).toBe(0)
    expect(JSON.parse(db.rows[0].payload).runner_error).toBeUndefined()
  })

  test('live D1 finite deadline aborts a hung runner without stale persistence', async () => {
    const db = new FakeAunRuntimeDb([pendingRuntimeRow('dev-001')])
    const outcome = await runAunRuntimeV2(db, {
      agentId: 'dev-001',
      queueId: '1001',
      messageId: 'msg-dev-001-1',
      createdAfter: '2026-06-18T00:00:00.000Z',
      claimTtlSeconds: 1,
      finalize: true,
      adapter: {
        runtime_id: 'hung-runtime', capabilities,
        execution_timeout_ms: 25, supportsAbort: true,
        async invoke(_envelope, opts) {
          expect(opts?.signal).toBeDefined()
          return await new Promise<QueueWorkResult>(() => {})
        },
      },
      d1Runtime: fakeD1Runtime(),
      env: {} as NodeJS.ProcessEnv,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'RUNNER_FAILED',
      runner: { ok: false, code: 'EXECUTION_ABORTED', detail: 'D1_EXECUTION_DEADLINE_EXCEEDED: 25ms' },
    })
    expect(db.rows[0].status).toBe('in_progress')
    expect(JSON.parse(db.rows[0].payload).runner_result).toBeUndefined()
    expect(JSON.parse(db.rows[0].payload).runner_error).toBeUndefined()
  })
})
