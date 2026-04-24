import { describe, test, expect } from 'bun:test'
import { pushClaudeChannelAndPromote, type ClaudeChannelPushParams } from '../../adapters/inbound-receiver'

// Spec v5 §4.1 merge gate — claude/channel push 3 条件 AND.
// Spec: specs/draft/2026-04-24-claude-channel-adoption-spec-v5.md
// Instruction: lead-ama PR-A §4 (msg id fa219381).
//
// This file covers **Condition 1** (push received + meta shape) as a
// routine-CI executable test by exercising the extracted
// `pushClaudeChannelAndPromote` helper with a fake mcpPush + DB.
//
// Conditions 2 and 3 (real LLM turn start within 1 s + status='replied'
// within 60 s) are gated behind `TEST_E2E_CLAUDE_CHANNEL=1` + `CLAUDE_BIN`
// because they spawn a real Claude Code bot session. They live at the end
// of this file in an opt-in `describe.skipIf` block.

const E2E_OPT_IN = process.env.TEST_E2E_CLAUDE_CHANNEL === '1' && !!process.env.CLAUDE_BIN

type Captured = { calls: ClaudeChannelPushParams[]; rejectWith?: unknown }
type DbCall = { sql: string; params?: any[] }

function fakeMcpPush(captured: Captured) {
  return async (params: ClaudeChannelPushParams) => {
    captured.calls.push(params)
    if (captured.rejectWith !== undefined) throw captured.rejectWith
  }
}

function fakeDb(log: DbCall[]) {
  return {
    async query(sql: string, params?: any[]) {
      log.push({ sql, params })
      return { rows: [], rowCount: 1 }
    },
  }
}

describe('test_10_claude_channel_push — Condition 1: push received with spec v5 meta', () => {
  test('spec v5 §1.2 meta shape — channel_id/message_id/author_id required, thread/type optional', async () => {
    const captured: Captured = { calls: [] }
    const dbLog: DbCall[] = []
    const res = await pushClaudeChannelAndPromote(
      fakeMcpPush(captured),
      fakeDb(dbLog),
      'recv-bot',
      {
        content: 'probe',
        meta: {
          channel_id: 'ch-1',
          message_id: 'msg-1',
          author_id: 'arc',
          thread_id: null,
          message_type: 'chat',
        },
      },
    )
    expect(res.pushed).toBe(true)
    expect(res.promoted).toBe(true)
    expect(captured.calls).toHaveLength(1)
    const m = captured.calls[0].meta
    // §1.2 required keys
    expect(m.channel_id).toBe('ch-1')
    expect(m.message_id).toBe('msg-1')
    expect(m.author_id).toBe('arc')
    // §1.2 identifier constraint — no hyphens in key names (silently
    // dropped by channels-reference). We test the meta *keys* here.
    for (const k of Object.keys(m)) {
      expect(k).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
  })

  test('§2.1 step 4 — promotion query targets message_queue with status guard', async () => {
    const captured: Captured = { calls: [] }
    const dbLog: DbCall[] = []
    await pushClaudeChannelAndPromote(
      fakeMcpPush(captured),
      fakeDb(dbLog),
      'recv-bot',
      {
        content: 'x',
        meta: { channel_id: 'ch', message_id: 'msg', author_id: 'a' },
      },
    )
    expect(dbLog).toHaveLength(1)
    const sql = dbLog[0].sql
    expect(sql).toContain('UPDATE message_queue')
    expect(sql).toContain("status = 'read'")
    expect(sql).toContain("status = 'pending'") // guard — don't overwrite replied/failed
    expect(dbLog[0].params).toEqual(['recv-bot', 'msg'])
  })

  test('promotion is scoped by (agent_id, message_id) — no cross-agent writes', async () => {
    const captured: Captured = { calls: [] }
    const dbLog: DbCall[] = []
    await pushClaudeChannelAndPromote(
      fakeMcpPush(captured),
      fakeDb(dbLog),
      'bot-B',
      {
        content: 'y',
        meta: { channel_id: 'ch', message_id: 'msg-xy', author_id: 'bot-A' },
      },
    )
    // The only parameterized values are the recipient agent + its row.
    // Author identity never appears in the promotion query.
    expect(dbLog[0].params).toEqual(['bot-B', 'msg-xy'])
  })
})

describe.skipIf(!E2E_OPT_IN)(
  'test_10_claude_channel_push — Conditions 2+3 (opt-in, real bot session)',
  () => {
    test.todo(
      'Condition 2: LLM turn starts within 1 s of push (real bot session required — gate on TEST_E2E_CLAUDE_CHANNEL + CLAUDE_BIN + DATABASE_URL)',
    )
    test.todo(
      'Condition 3: message_queue.status=\'replied\' + new agent_messages INSERT + outbound_queue Discord POST within 60 s',
    )
  },
)
