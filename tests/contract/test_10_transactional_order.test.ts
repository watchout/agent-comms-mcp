import { describe, test, expect } from 'bun:test'
import { pushClaudeChannelAndPromote, type ClaudeChannelPushParams } from '../../adapters/inbound-receiver'

// Spec v5 §2.1 / §4.2 transactional order — push failure must NOT
// promote message_queue to 'read'. The row stays 'pending' so the
// wake-daemon polling fallback (Codex/Gemini + outage recovery) keeps
// the message deliverable (claude-peers-mcp Issue #8 guard).
// Instruction: lead-ama PR-A §4.2 (msg id fa219381).

type DbCall = { sql: string; params?: any[] }

function rejectingMcpPush(err: unknown) {
  return async (_params: ClaudeChannelPushParams) => {
    throw err
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

describe('test_10_transactional_order — push rejection keeps status=pending', () => {
  test('push throws → pushed=false, promoted=false, NO UPDATE issued', async () => {
    const dbLog: DbCall[] = []
    const res = await pushClaudeChannelAndPromote(
      rejectingMcpPush(new Error('ECONNREFUSED: client disconnected')),
      fakeDb(dbLog),
      'recv',
      { content: 'x', meta: { channel_id: 'c', message_id: 'm', author_id: 'a' } },
    )
    expect(res.pushed).toBe(false)
    expect(res.promoted).toBe(false)
    expect(res.error).toBeInstanceOf(Error)
    // Critical invariant: no UPDATE message_queue was issued on push
    // failure. The wake-daemon fallback reads 'pending' rows, so any
    // status mutation here would silently drop the message.
    expect(dbLog).toHaveLength(0)
  })

  test('push ok but DB promote throws → pushed=true, promoted=false (error recorded, push still wins)', async () => {
    const failingDb = {
      async query() {
        throw new Error('pg: connection terminated')
      },
    }
    const res = await pushClaudeChannelAndPromote(
      async () => {},
      failingDb,
      'recv',
      { content: 'x', meta: { channel_id: 'c', message_id: 'm', author_id: 'a' } },
    )
    // The push landed — we never downgrade a successful push. The
    // caller logs the promote failure; the next pull via `next` will
    // still see 'pending' and re-deliver (idempotent at the bot side).
    expect(res.pushed).toBe(true)
    expect(res.promoted).toBe(false)
  })

  test('non-Error throws (string / object) are still treated as push failure (no crash, no promote)', async () => {
    const dbLog: DbCall[] = []
    const res = await pushClaudeChannelAndPromote(
      async () => { throw 'disconnected' as any },
      fakeDb(dbLog),
      'recv',
      { content: 'x', meta: { channel_id: 'c', message_id: 'm', author_id: 'a' } },
    )
    expect(res.pushed).toBe(false)
    expect(dbLog).toHaveLength(0)
  })
})
