import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { migrateSqlite } from '../db/migrate-sqlite'
import { unlinkSync } from 'node:fs'

const TEST_DB = '/tmp/agent-com-test-adapter.db'

describe('SqliteAdapter', () => {
  let adapter: SqliteAdapter

  beforeAll(() => {
    try { unlinkSync(TEST_DB) } catch {}
    migrateSqlite(TEST_DB)
    adapter = new SqliteAdapter(TEST_DB)
  })

  afterAll(async () => {
    await adapter.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  it('query returns rows', async () => {
    const rows = await adapter.query('SELECT 1 as val')
    expect(rows).toHaveLength(1)
    expect(rows[0].val).toBe(1)
  })

  it('queryOne returns single row or null', async () => {
    const row = await adapter.queryOne('SELECT 1 as val')
    expect(row?.val).toBe(1)

    const none = await adapter.queryOne("SELECT 1 as val WHERE 1 = 0")
    expect(none).toBeNull()
  })

  it('execute returns rowCount', async () => {
    await adapter.execute(
      "INSERT INTO agents (agent_id, display_name, agent_type) VALUES (?, ?, ?)",
      ['test-bot', 'Test Bot', 'dev']
    )
    const result = await adapter.execute(
      "UPDATE agents SET status = ? WHERE agent_id = ?",
      ['idle', 'test-bot']
    )
    expect(result.rowCount).toBe(1)
  })

  it('transaction commits on success', async () => {
    await adapter.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO channels (id, name) VALUES (?, ?)",
        ['test-ch', 'Test Channel']
      )
    })
    const ch = await adapter.queryOne("SELECT * FROM channels WHERE id = ?", ['test-ch'])
    expect(ch?.name).toBe('Test Channel')
  })

  it('transaction rolls back on error', async () => {
    try {
      await adapter.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO channels (id, name) VALUES (?, ?)",
          ['rollback-ch', 'Rollback']
        )
        throw new Error('test rollback')
      })
    } catch {}
    const ch = await adapter.queryOne("SELECT * FROM channels WHERE id = ?", ['rollback-ch'])
    expect(ch).toBeNull()
  })

  it('$1 param conversion works', async () => {
    const rows = await adapter.query(
      "SELECT * FROM agents WHERE agent_id = $1",
      ['test-bot']
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe('test-bot')
  })

  it('NOW() conversion works', async () => {
    await adapter.execute(
      "INSERT INTO agents (agent_id, display_name, agent_type, created_at) VALUES ($1, $2, $3, NOW())",
      ['now-bot', 'Now Bot', 'dev']
    )
    const row = await adapter.queryOne("SELECT created_at FROM agents WHERE agent_id = $1", ['now-bot'])
    expect(row?.created_at).toBeTruthy()
  })

  it('message_queue INSERT + claim cycle works', async () => {
    await adapter.execute(
      `INSERT INTO message_queue (agent_id, message_id, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      ['test-bot', 'msg-001', '{"content":"hello"}']
    )

    const pending = await adapter.queryOne(
      `SELECT * FROM message_queue WHERE agent_id = $1 AND status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1`,
      ['test-bot']
    )
    expect(pending?.message_id).toBe('msg-001')

    await adapter.execute(
      "UPDATE message_queue SET status = 'read', read_at = datetime('now') WHERE id = $1",
      [pending!.id]
    )
    const read = await adapter.queryOne("SELECT status FROM message_queue WHERE id = $1", [pending!.id])
    expect(read?.status).toBe('read')
  })

  it('outbound_queue INSERT + claim works', async () => {
    await adapter.execute(
      `INSERT INTO outbound_queue (message_id, agent_id, channel_external_id, content)
       VALUES ($1, $2, $3, $4)`,
      ['msg-out-001', 'test-bot', '12345', 'hello discord']
    )

    const row = await adapter.queryOne(
      `SELECT * FROM outbound_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    )
    expect(row?.content).toBe('hello discord')
  })
})

describe('migrateSqlite', () => {
  const MIGRATE_DB = '/tmp/agent-com-test-migrate.db'

  afterAll(() => {
    try { unlinkSync(MIGRATE_DB) } catch {}
  })

  it('creates all tables idempotently', () => {
    migrateSqlite(MIGRATE_DB)
    migrateSqlite(MIGRATE_DB) // second run should not throw

    const db = new (require('bun:sqlite').Database)(MIGRATE_DB)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    const names = tables.map((t: any) => t.name)

    expect(names).toContain('agent_messages')
    expect(names).toContain('message_queue')
    expect(names).toContain('outbound_queue')
    expect(names).toContain('agents')
    expect(names).toContain('channels')
    expect(names).toContain('threads')
    db.close()
  })
})
