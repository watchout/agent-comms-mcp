import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { allocateConversationRoot } from '../../core/conversation-control-plane'
import { migrateSqlite } from '../../db/migrate-sqlite'

let dbPath: string
let db: SqliteAdapter

beforeEach(() => {
  dbPath = join(tmpdir(), `agent-com-conversation-control-plane-${process.pid}-${Date.now()}.db`)
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
})

afterEach(async () => {
  await db.close()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

async function seedChannelAndAgents(): Promise<void> {
  await db.execute(`INSERT INTO channels (id, name, members) VALUES ($1, $2, $3)`, [
    'audit-channel',
    'audit-channel',
    '["owner-a","owner-b"]',
  ])
  for (const agentId of ['owner-a', 'owner-b']) {
    await db.execute(`INSERT INTO agents (agent_id, display_name, agent_type) VALUES ($1, $2, 'dev')`, [
      agentId,
      agentId,
    ])
  }
}

async function seedMessageAndQueue(agentId = 'owner-a'): Promise<{ messageId: string; queueId: number }> {
  const messageId = randomUUID()
  await db.execute(`
    INSERT INTO agent_messages (id, channel_id, author_id, content)
    VALUES ($1, 'audit-channel', 'operator', 'work')
  `, [messageId])
  await db.execute(`
    INSERT INTO message_queue (agent_id, message_id, payload, status)
    VALUES ($1, $2, $3, 'pending')
  `, [agentId, messageId, JSON.stringify({ content: 'work' })])
  const queue = await db.queryOne<{ id: number }>(`SELECT id FROM message_queue WHERE message_id = $1`, [messageId])
  if (!queue) throw new Error('queue seed failed')
  return { messageId, queueId: queue.id }
}

describe('conversation control-plane allocation', () => {
  test('allocates conversation and active baton, then stamps message and queue in one transaction', async () => {
    await seedChannelAndAgents()
    const { messageId, queueId } = await seedMessageAndQueue()

    const allocated = await allocateConversationRoot(db, {
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_message_id: messageId,
      owner_agent_id: 'owner-a',
      message_id: messageId,
      source_queue_id: queueId,
      claim_id: 'claim-1',
    })

    expect(allocated.ok).toBe(true)
    if (!allocated.ok) return
    expect(allocated.conversation_action).toBe('created')
    expect(allocated.baton_action).toBe('created')
    expect(allocated.baton.owner_agent_id).toBe('owner-a')
    expect(allocated.baton.claim_id).toBe('claim-1')

    const message = await db.queryOne<{ conversation_id: string; baton_id: string }>(
      `SELECT conversation_id, baton_id FROM agent_messages WHERE id = $1`,
      [messageId],
    )
    const queue = await db.queryOne<{ conversation_id: string; baton_id: string }>(
      `SELECT conversation_id, baton_id FROM message_queue WHERE id = $1`,
      [queueId],
    )
    expect(message).toEqual({ conversation_id: allocated.conversation_id, baton_id: allocated.baton_id })
    expect(queue).toEqual({ conversation_id: allocated.conversation_id, baton_id: allocated.baton_id })
  })

  test('idempotent retry reuses the existing active baton for the same owner', async () => {
    await seedChannelAndAgents()
    const { messageId, queueId } = await seedMessageAndQueue()
    const input = {
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_message_id: messageId,
      owner_agent_id: 'owner-a',
      message_id: messageId,
      source_queue_id: queueId,
    }

    const first = await allocateConversationRoot(db, input)
    const second = await allocateConversationRoot(db, input)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.conversation_action).toBe('reused')
    expect(second.baton_action).toBe('reused')
    expect(second.conversation_id).toBe(first.conversation_id)
    expect(second.baton_id).toBe(first.baton_id)
    const batons = await db.query(`SELECT baton_id FROM conversation_batons`)
    expect(batons).toHaveLength(1)
  })

  test('same conversation root cannot silently switch active owner', async () => {
    await seedChannelAndAgents()
    const { messageId, queueId } = await seedMessageAndQueue()
    const first = await allocateConversationRoot(db, {
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_message_id: messageId,
      owner_agent_id: 'owner-a',
      source_queue_id: queueId,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const conflicting = await allocateConversationRoot(db, {
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_message_id: messageId,
      owner_agent_id: 'owner-b',
      source_queue_id: queueId,
    })
    expect(conflicting).toEqual({
      ok: false,
      error: 'ACTIVE_BATON_OWNER_MISMATCH',
      detail: first.baton_id,
    })
  })

  test('continues an existing conversation with its active baton', async () => {
    await seedChannelAndAgents()
    const root = await seedMessageAndQueue()
    const allocated = await allocateConversationRoot(db, {
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_message_id: root.messageId,
      owner_agent_id: 'owner-a',
      source_queue_id: root.queueId,
    })
    expect(allocated.ok).toBe(true)
    if (!allocated.ok) return

    const reply = await seedMessageAndQueue()
    const continued = await allocateConversationRoot(db, {
      surface: 'mcp',
      channel_id: 'audit-channel',
      reply_to_conversation_id: allocated.conversation_id,
      owner_agent_id: 'owner-a',
      message_id: reply.messageId,
      source_queue_id: reply.queueId,
    })

    expect(continued.ok).toBe(true)
    if (!continued.ok) return
    expect(continued.conversation_action).toBe('continued')
    expect(continued.baton_action).toBe('reused')
    expect(continued.baton_id).toBe(allocated.baton_id)
  })

  test('rolls back conversation and baton when a required message stamp fails', async () => {
    await seedChannelAndAgents()

    const allocated = await allocateConversationRoot(db, {
      surface: 'mcp',
      channel_id: 'audit-channel',
      root_request_id: 'rollback-root',
      owner_agent_id: 'owner-a',
      message_id: 'missing-message',
    })

    expect(allocated).toEqual({
      ok: false,
      error: 'MESSAGE_CONVERSATION_STAMP_NOT_FOUND',
      detail: 'missing-message',
    })
    expect(await db.query(`SELECT conversation_id FROM conversations`)).toHaveLength(0)
    expect(await db.query(`SELECT baton_id FROM conversation_batons`)).toHaveLength(0)
  })
})
