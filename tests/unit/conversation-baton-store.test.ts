import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { createConversationBaton, findActiveConversationBaton, transferConversationBaton } from '../../core/conversation-baton-store'
import { persistConversationResolution } from '../../core/conversation-store'
import { resolveConversationIdentity } from '../../core/conversation-identity'
import { migrateSqlite } from '../../db/migrate-sqlite'

let dbPath: string
let db: SqliteAdapter

beforeEach(() => {
  dbPath = join(tmpdir(), `agent-com-baton-store-${process.pid}-${Date.now()}.db`)
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
})

afterEach(async () => {
  await db.close()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

async function seedConversation(): Promise<string> {
  await db.execute(`INSERT INTO channels (id, name, members) VALUES ($1, $2, $3)`, [
    'audit-channel',
    'audit-channel',
    '["owner-a","owner-b"]',
  ])
  await db.execute(`INSERT INTO agents (agent_id, display_name, agent_type) VALUES ($1, $2, 'dev')`, [
    'owner-a',
    'owner-a',
  ])
  await db.execute(`INSERT INTO agents (agent_id, display_name, agent_type) VALUES ($1, $2, 'dev')`, [
    'owner-b',
    'owner-b',
  ])
  const persisted = await persistConversationResolution(db, resolveConversationIdentity({
    surface: 'mcp',
    channel_id: 'audit-channel',
    root_request_id: 'baton-root',
  }))
  expect(persisted.ok).toBe(true)
  if (!persisted.ok) throw new Error('conversation seed failed')
  return persisted.conversation_id
}

describe('conversation baton store', () => {
  test('creates exactly one active baton for a conversation', async () => {
    const conversationId = await seedConversation()
    const first = await createConversationBaton(db, {
      conversation_id: conversationId,
      owner_agent_id: 'owner-a',
      claim_id: 'claim-a',
    })
    const second = await createConversationBaton(db, {
      conversation_id: conversationId,
      owner_agent_id: 'owner-b',
      claim_id: 'claim-b',
    })

    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.baton).toMatchObject({
      conversation_id: conversationId,
      owner_agent_id: 'owner-a',
      state: 'active',
      claim_id: 'claim-a',
    })
    expect(second).toEqual({
      ok: false,
      error: 'ACTIVE_BATON_EXISTS',
      detail: first.baton.baton_id,
    })
  })

  test('finds the active baton and ignores transferred batons', async () => {
    const conversationId = await seedConversation()
    const first = await createConversationBaton(db, {
      conversation_id: conversationId,
      owner_agent_id: 'owner-a',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const transfer = await transferConversationBaton(db, {
      conversation_id: conversationId,
      from_baton_id: first.baton.baton_id,
      to_owner_agent_id: 'owner-b',
      completion_outcome: 'handoff',
    })
    expect(transfer.ok).toBe(true)
    if (!transfer.ok) return

    const active = await findActiveConversationBaton(db, conversationId)
    expect(active?.baton_id).toBe(transfer.baton.baton_id)
    expect(active?.owner_agent_id).toBe('owner-b')

    const old = await db.queryOne<{ state: string; completion_outcome: string }>(
      `SELECT state, completion_outcome FROM conversation_batons WHERE baton_id = $1`,
      [first.baton.baton_id],
    )
    expect(old).toEqual({ state: 'transferred', completion_outcome: 'handoff' })
  })

  test('transfer fails closed when the source baton is no longer active', async () => {
    const conversationId = await seedConversation()
    const first = await createConversationBaton(db, {
      conversation_id: conversationId,
      owner_agent_id: 'owner-a',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const transfer = await transferConversationBaton(db, {
      conversation_id: conversationId,
      from_baton_id: first.baton.baton_id,
      to_owner_agent_id: 'owner-b',
    })
    expect(transfer.ok).toBe(true)

    const retry = await transferConversationBaton(db, {
      conversation_id: conversationId,
      from_baton_id: first.baton.baton_id,
      to_owner_agent_id: 'owner-a',
    })
    expect(retry).toEqual({
      ok: false,
      error: 'ACTIVE_BATON_NOT_FOUND',
      detail: first.baton.baton_id,
    })
  })
})
