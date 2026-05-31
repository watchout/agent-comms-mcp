import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  findConversationByKeyHash,
  persistConversationResolution,
  stampAgentMessageConversation,
  stampQueueConversation,
} from '../../core/conversation-store'
import { resolveConversationIdentity } from '../../core/conversation-identity'
import { migrateSqlite } from '../../db/migrate-sqlite'

let dbPath: string
let db: SqliteAdapter

beforeEach(() => {
  dbPath = join(tmpdir(), `agent-com-conversation-store-${process.pid}-${Date.now()}.db`)
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
})

afterEach(async () => {
  await db.close()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

async function seedChannel(channelId = 'audit-channel'): Promise<void> {
  await db.execute(`INSERT INTO channels (id, name, members) VALUES ($1, $2, $3)`, [
    channelId,
    channelId,
    '[]',
  ])
}

describe('conversation store', () => {
  test('creates and reads a conversation from a deterministic root request key', async () => {
    await seedChannel()
    const resolution = resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_request_id: 'audit-request-1',
      conversation_kind: 'audit',
    })

    const persisted = await persistConversationResolution(db, resolution)
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return
    expect(persisted.action).toBe('created')
    expect(persisted.conversation?.key).toEqual({
      surface: 'mcp',
      channel_id: 'audit-channel',
      thread_scope_id: 'audit-channel',
      root_request_id: 'audit-request-1',
      conversation_kind: 'audit',
    })

    const found = await findConversationByKeyHash(db, persisted.conversation!.conversation_key_hash)
    expect(found?.conversation_id).toBe(persisted.conversation_id)
    expect(found?.conversation_kind).toBe('audit')
  })

  test('reuses an existing conversation for the same key hash', async () => {
    await seedChannel()
    const resolution = resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_request_id: 'audit-request-1',
      conversation_kind: 'audit',
    })

    const first = await persistConversationResolution(db, resolution)
    const second = await persistConversationResolution(db, resolution)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.action).toBe('created')
    expect(second.action).toBe('reused')
    expect(second.conversation_id).toBe(first.conversation_id)
  })

  test('records explicit fanout child parent links', async () => {
    await seedChannel()
    const parent = await persistConversationResolution(db, resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_request_id: 'parent-request',
    }))
    expect(parent.ok).toBe(true)
    if (!parent.ok) return

    const child = await persistConversationResolution(db, resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_request_id: 'child-request-a',
      parent_conversation_id: parent.conversation_id,
      conversation_kind: 'fanout_child',
    }))

    expect(child.ok).toBe(true)
    if (!child.ok) return
    expect(child.action).toBe('created')
    expect(child.conversation?.parent_conversation_id).toBe(parent.conversation_id)
    expect(child.conversation?.conversation_kind).toBe('fanout_child')
  })

  test('passes through existing conversation continuations without inserting rows', async () => {
    const continued = await persistConversationResolution(db, resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'audit-channel',
      reply_to_conversation_id: 'existing-conversation-id',
    }))

    expect(continued).toEqual({
      ok: true,
      action: 'continued',
      conversation_id: 'existing-conversation-id',
    })
    const rows = await db.query(`SELECT conversation_id FROM conversations`)
    expect(rows).toHaveLength(0)
  })

  test('stamps conversation ids onto message and queue rows without creating batons', async () => {
    await seedChannel()
    await db.execute(`INSERT INTO agents (agent_id, display_name, agent_type) VALUES ($1, $2, 'dev')`, [
      'owner-agent',
      'owner-agent',
    ])
    const persisted = await persistConversationResolution(db, resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_request_id: 'stamp-root',
    }))
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return

    const messageId = randomUUID()
    await db.execute(`
      INSERT INTO agent_messages (id, channel_id, author_id, content)
      VALUES ($1, 'audit-channel', 'owner-agent', 'hello')
    `, [messageId])
    await db.execute(`
      INSERT INTO message_queue (agent_id, message_id, payload, status)
      VALUES ('owner-agent', $1, $2, 'pending')
    `, [messageId, JSON.stringify({ content: 'hello' })])
    const queue = await db.queryOne<{ id: number }>(`SELECT id FROM message_queue WHERE message_id = $1`, [messageId])
    expect(queue?.id).toBeTruthy()

    const messageStamp = await stampAgentMessageConversation(db, {
      message_id: messageId,
      conversation_id: persisted.conversation_id,
    })
    const queueStamp = await stampQueueConversation(db, {
      queue_id: queue!.id,
      conversation_id: persisted.conversation_id,
    })

    expect(messageStamp).toEqual({
      ok: true,
      conversation_id: persisted.conversation_id,
      baton_id: null,
    })
    expect(queueStamp).toEqual({
      ok: true,
      conversation_id: persisted.conversation_id,
      baton_id: null,
    })
    const batons = await db.query(`SELECT baton_id FROM conversation_batons`)
    expect(batons).toHaveLength(0)
  })

  test('fails closed when stamping unknown rows', async () => {
    const missingMessage = await stampAgentMessageConversation(db, {
      message_id: 'missing-message',
      conversation_id: randomUUID(),
    })
    const missingQueue = await stampQueueConversation(db, {
      queue_id: 99999,
      conversation_id: randomUUID(),
    })

    expect(missingMessage).toEqual({
      ok: false,
      error: 'MESSAGE_CONVERSATION_STAMP_NOT_FOUND',
      detail: 'missing-message',
    })
    expect(missingQueue).toEqual({
      ok: false,
      error: 'QUEUE_CONVERSATION_STAMP_NOT_FOUND',
      detail: '99999',
    })
  })
})
