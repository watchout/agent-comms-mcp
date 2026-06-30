import { describe, expect, test } from 'bun:test'
import {
  finalizeAunRuntimeV2MediatedQueueWork,
  parseAunRuntimeV2TerminalEvidence,
} from '../core/aun-runtime-v2-finalization'
import {
  QUEUE_WORK_RESULT_VERSION,
  type QueueWorkDb,
  type QueueWorkGithubIssueCommentWriteback,
  type QueueWorkResult,
  type QueueWorkWritebackSender,
} from '../core/queue-work'

class FakeFinalizationDb implements QueueWorkDb {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(public row: any | null) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes('SELECT id, agent_id, message_id, payload, status')) {
      if (!this.row) return { rows: [], rowCount: 0 }
      if (sql.includes('WHERE id = $1') && String(this.row.id) !== String(params?.[0])) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [{ ...this.row }] as T[], rowCount: 1 }
    }
    if (sql.includes('last_heartbeat_at = $3')) {
      if (!this.row || String(this.row.id) !== String(params?.[0]) || this.row.status !== 'done') {
        return { rows: [], rowCount: 0 }
      }
      this.row.payload = params?.[1]
      this.row.last_heartbeat_at = params?.[2]
      return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
    }
    if (sql.includes("SET status = 'replied'")) {
      if (!this.row || String(this.row.id) !== String(params?.[0]) || this.row.status !== 'done') {
        return { rows: [], rowCount: 0 }
      }
      this.row.status = 'replied'
      this.row.replied_at = params?.[1]
      this.row.replied_with = params?.[2]
      this.row.payload = params?.[3]
      this.row.claimed_by = null
      this.row.claimed_at = null
      this.row.claim_expires_at = null
      return { rows: [{ id: this.row.id }] as T[], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in mediated finalization fake: ${sql}`)
  }
}

function result(overrides: Partial<QueueWorkResult> = {}): QueueWorkResult {
  return {
    schema_version: QUEUE_WORK_RESULT_VERSION,
    ok: true,
    summary: 'runtime-v2 work completed',
    reply: null,
    evidence: [
      'semantic_outcome=close',
      'outcome_reason=runtime_v2_completed',
      'fixture:evidence',
    ],
    next_action: 'close',
    ...overrides,
  }
}

function doneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    agent_id: 'kodama',
    message_id: 'msg-kodama-1',
    status: 'done',
    payload: JSON.stringify({
      channel_id: 'aun-v2-canary',
      author_id: 'agent-com-dev',
      content: 'runtime-v2 finalization fixture',
      runner_result: result(),
    }),
    priority: 0,
    created_at: '2026-06-28T00:00:00.000Z',
    claimed_by: 'kodama',
    claimed_at: '2026-06-28T00:00:01.000Z',
    claim_expires_at: '2026-06-28T00:05:01.000Z',
    ...overrides,
  }
}

function githubBackedDoneRow(writeback?: QueueWorkGithubIssueCommentWriteback) {
  return doneRow({
    payload: JSON.stringify({
      author_id: 'agent-com-dev',
      content: 'Audit required. GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/824',
      message_type: 'phase_handoff',
      runner_result: result({
        writeback: writeback ?? null,
      }),
    }),
  })
}

describe('AUN runtime-v2 mediated finalization', () => {
  test('requires queue_id and message_id before DB access', async () => {
    const db = new FakeFinalizationDb(doneRow())

    const outcome = await finalizeAunRuntimeV2MediatedQueueWork(db, {
      queueId: 1001,
    })

    expect(outcome).toMatchObject({ error: 'fence_required' })
    expect(db.calls).toEqual([])
  })

  test('parses terminal evidence from existing queue_work_result_v1 evidence entries', () => {
    expect(parseAunRuntimeV2TerminalEvidence(result())).toEqual({
      semantic_outcome: 'close',
      outcome_reason: 'runtime_v2_completed',
      evidence_refs: ['fixture:evidence'],
    })
  })

  test('rejects malformed runner_result before terminal close', async () => {
    const db = new FakeFinalizationDb(doneRow({
      payload: JSON.stringify({
        content: 'malformed result fixture',
        runner_result: {
          schema_version: 'wrong',
          ok: true,
        },
      }),
    }))

    const outcome = await finalizeAunRuntimeV2MediatedQueueWork(db, {
      queueId: 1001,
      messageId: 'msg-kodama-1',
    })

    expect(outcome).toMatchObject({
      schema_version: 'aun-runtime-v2-mediated-finalization/v1',
      finalization: {
        finalized: false,
        reason_code: 'terminal_evidence_invalid',
      },
    })
    expect(db.row.status).toBe('done')
    expect(db.calls.map((call) => call.sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      'ROLLBACK',
    ])
  })

  test('requires terminal evidence before terminal close', async () => {
    const db = new FakeFinalizationDb(doneRow({
      payload: JSON.stringify({
        content: 'missing terminal evidence fixture',
        runner_result: result({ evidence: ['fixture:evidence'] }),
      }),
    }))

    const outcome = await finalizeAunRuntimeV2MediatedQueueWork(db, {
      queueId: 1001,
      messageId: 'msg-kodama-1',
      now: () => new Date('2026-06-28T00:10:00.000Z'),
    })

    expect(outcome).toMatchObject({
      finalization: {
        finalized: false,
        reason_code: 'TERMINAL_EVIDENCE_INVALID',
      },
    })
    expect(db.row.status).toBe('done')
    expect(JSON.parse(db.row.payload).finalizer_error).toMatchObject({
      code: 'TERMINAL_EVIDENCE_INVALID',
    })
  })

  test('enforces message_id exact fence before terminal close', async () => {
    const db = new FakeFinalizationDb(doneRow())

    const outcome = await finalizeAunRuntimeV2MediatedQueueWork(db, {
      queueId: 1001,
      messageId: 'wrong-message',
    })

    expect(outcome).toMatchObject({
      finalization: {
        finalized: false,
        reason_code: 'MESSAGE_FENCE_MISMATCH',
      },
    })
    expect(db.row.status).toBe('done')
    expect(db.calls.map((call) => call.sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      'ROLLBACK',
    ])
  })

  test('closes non-GitHub-backed work with valid terminal evidence', async () => {
    const db = new FakeFinalizationDb(doneRow())

    const outcome = await finalizeAunRuntimeV2MediatedQueueWork(db, {
      queueId: 1001,
      messageId: 'msg-kodama-1',
      now: () => new Date('2026-06-28T00:10:00.000Z'),
    })

    expect(outcome).toMatchObject({
      terminal_evidence: {
        semantic_outcome: 'close',
        outcome_reason: 'runtime_v2_completed',
      },
      finalization: {
        finalized: true,
        reason_code: 'CLOSED',
      },
    })
    expect(db.row.status).toBe('replied')
    expect(db.row.claimed_by).toBeNull()
  })

  test('requires mediated writeback for GitHub-backed handoffs', async () => {
    const db = new FakeFinalizationDb(githubBackedDoneRow())

    const outcome = await finalizeAunRuntimeV2MediatedQueueWork(db, {
      queueId: 1001,
      messageId: 'msg-kodama-1',
    })

    expect(outcome).toMatchObject({
      finalization: {
        finalized: false,
        reason_code: 'MISSING_WRITEBACK',
      },
    })
    expect(db.row.status).toBe('done')
    expect(JSON.parse(db.row.payload).finalizer_error).toMatchObject({
      code: 'MISSING_WRITEBACK',
    })
  })

  test('records mediated writeback evidence before closing GitHub-backed handoffs', async () => {
    const writeback = {
      mode: 'github_issue_comment' as const,
      repo: 'watchout/agent-comms-mcp',
      issue_number: 824,
      body: 'structured audit result',
      evidence: ['exact_head:e04c953'],
    }
    const db = new FakeFinalizationDb(githubBackedDoneRow(writeback))
    const posted: unknown[] = []
    const writebackSender: QueueWorkWritebackSender = {
      async sendWriteback(input) {
        posted.push(input)
        return {
          posted_with: 'https://github.com/watchout/agent-comms-mcp/pull/824#issuecomment-1',
          body_sha256: 'a'.repeat(64),
        }
      },
    }

    const outcome = await finalizeAunRuntimeV2MediatedQueueWork(db, {
      queueId: 1001,
      messageId: 'msg-kodama-1',
      writebackSender,
    })

    expect(outcome).toMatchObject({
      finalization: {
        finalized: true,
        reason_code: 'WRITEBACK_POSTED',
      },
    })
    expect(posted).toEqual([
      expect.objectContaining({
        queue_id: '1001',
        agent_id: 'kodama',
        writeback,
      }),
    ])
    expect(JSON.parse(db.row.payload).writeback_result).toMatchObject({
      posted_with: 'https://github.com/watchout/agent-comms-mcp/pull/824#issuecomment-1',
      body_sha256: 'a'.repeat(64),
    })
  })
})
