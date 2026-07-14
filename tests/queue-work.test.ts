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
      if (this.row && String(this.row.id) === String(params?.[0]) && (this.row.status === 'in_progress' || this.row.status === 'done')) {
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

function shirubeHandoffContent(input: {
  activeFunction: string
  canonicalSeat: string
  agentId: string
}): string {
  return [
    'schema_version: shirube-v3/control_handoff/v1',
    'execution_context:',
    `  active_function: ${input.activeFunction}`,
    'target:',
    `  agent_id: ${input.agentId}`,
    `  canonical_seat: ${input.canonicalSeat}`,
    'cell:',
    '  id: TEST-AUDIT-ROUTE-001',
    'next_action:',
    '  blocking: true',
    '  action: verify route tuple',
    'GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/867',
  ].join('\n')
}

function shirubeHandoffRow(input: {
  rowAgentId: string
  activeFunction: string
  canonicalSeat: string
  targetAgentId: string
}) {
  return receivedRow({
    agent_id: input.rowAgentId,
    payload: JSON.stringify({
      author_id: 'codex-cto',
      content: shirubeHandoffContent({
        activeFunction: input.activeFunction,
        canonicalSeat: input.canonicalSeat,
        agentId: input.targetAgentId,
      }),
      message_type: 'phase_handoff',
    }),
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

  test('content YAML evidence_audit_gate targeted to devauditor blocks instead of normalizing from agent id', () => {
    const envelope = buildQueueWorkEnvelope(shirubeHandoffRow({
      rowAgentId: 'devauditor',
      activeFunction: 'evidence_audit_gate',
      canonicalSeat: 'devauditor',
      targetAgentId: 'devauditor',
    }))

    expect(envelope.handoff_contract).toMatchObject({
      kind: 'github_backed_role_handoff',
      active_function: 'evidence_audit_gate',
      canonical_seat: 'devauditor',
      canonical_agent_id: null,
      route_blocker: 'CANONICAL_SEAT_MISMATCH',
    })
    expect(envelope.handoff_contract.detected_from).toEqual(expect.arrayContaining([
      'content:active_function',
      'content:canonical_seat',
      'content:agent_id',
    ]))
  })

  test('content YAML evidence_audit_gate targeted to codex-audit resolves canonical route', () => {
    const envelope = buildQueueWorkEnvelope(shirubeHandoffRow({
      rowAgentId: 'codex-audit',
      activeFunction: 'evidence_audit_gate',
      canonicalSeat: 'codex-audit',
      targetAgentId: 'codex-audit',
    }))

    expect(envelope.handoff_contract).toMatchObject({
      kind: 'github_backed_role_handoff',
      active_function: 'evidence_audit_gate',
      canonical_seat: 'codex-audit',
      canonical_agent_id: 'codex-audit',
      route_blocker: null,
      audit_route: expect.objectContaining({
        agent_id: 'codex-audit',
        route_kind: 'evidence_audit_gate',
      }),
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
