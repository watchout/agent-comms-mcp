#!/usr/bin/env bun
/**
 * Tests for spec §18.1 Reply Chain Context — the `WITH RECURSIVE` CTE in
 * `core/reply-chain.ts`. Uses SQLite (bun:sqlite) so the test is hermetic;
 * SqliteAdapter rewrites `->>'...'` / `TIMESTAMPTZ` / `$n` for us. The same
 * CTE shape is SQL-standard and runs unchanged on PostgreSQL.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { fetchReplyChain, parseReplyChainDepth } from '../core/reply-chain'

let db: SqliteAdapter
let dbPath: string

beforeEach(async () => {
  dbPath = `/tmp/reply-chain-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  db = new SqliteAdapter(dbPath)
  // Minimal schema — reply-chain only needs id/channel_id/author_id/content/reply_to/created_at.
  await db.execute(`
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reply_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
})

afterEach(async () => {
  await db.close()
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(dbPath)
  } catch {}
})

async function insert(
  id: string,
  author: string,
  content: string,
  replyTo: string | null,
  createdAt: string,
) {
  await db.execute(
    `INSERT INTO agent_messages (id, channel_id, author_id, content, reply_to, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, 'ch1', author, content, replyTo, createdAt],
  )
}

describe('fetchReplyChain', () => {
  test('reply_to chain is returned oldest-first, excluding the seed message', async () => {
    await insert('m1', 'alice', 'first',  null, '2026-04-18T00:00:00Z')
    await insert('m2', 'bob',   'second', 'm1', '2026-04-18T00:00:01Z')
    await insert('m3', 'alice', 'third',  'm2', '2026-04-18T00:00:02Z')
    await insert('m4', 'bob',   'fourth', 'm3', '2026-04-18T00:00:03Z')

    const chain = await fetchReplyChain('m4', 10, db)
    // Seed row (m4) is stripped; ancestors returned oldest-first.
    expect(chain.map((e) => e.id)).toEqual(['m1', 'm2', 'm3'])
    expect(chain.map((e) => e.from)).toEqual(['alice', 'bob', 'alice'])
    expect(chain[0].content).toBe('first')
  })

  test('returns [] when reply_to is null/undefined', async () => {
    await insert('m1', 'alice', 'solo', null, '2026-04-18T00:00:00Z')
    expect(await fetchReplyChain(null, 10, db)).toEqual([])
    expect(await fetchReplyChain(undefined, 10, db)).toEqual([])
  })

  test('depth limit stops traversal and prevents infinite loop on cycles', async () => {
    // a → b → a (direct cycle)
    await insert('a', 'x', 'A', 'b', '2026-04-18T00:00:00Z')
    await insert('b', 'y', 'B', 'a', '2026-04-18T00:00:01Z')

    const chain = await fetchReplyChain('a', 3, db)
    // With depth=3 the CTE emits up to 3 rows; dedup is the caller's job but
    // the query must TERMINATE, which is the guard we're pinning here.
    expect(chain.length).toBeLessThanOrEqual(3)
  })

  test('caller-supplied depth caps the walk', async () => {
    // 5-deep linear chain
    await insert('m1', 'a', '1',  null, '2026-04-18T00:00:00Z')
    await insert('m2', 'b', '2', 'm1', '2026-04-18T00:00:01Z')
    await insert('m3', 'a', '3', 'm2', '2026-04-18T00:00:02Z')
    await insert('m4', 'b', '4', 'm3', '2026-04-18T00:00:03Z')
    await insert('m5', 'a', '5', 'm4', '2026-04-18T00:00:04Z')

    const chain = await fetchReplyChain('m5', 2, db)
    // depth=2 means the CTE emits at most 2 levels of ancestry (seed + 1 more);
    // after stripping the seed, 1 ancestor remains.
    expect(chain.length).toBe(1)
    expect(chain[0].id).toBe('m4')
  })

  test('missing seed row returns []', async () => {
    expect(await fetchReplyChain('nonexistent', 10, db)).toEqual([])
  })

  test('depth <= 0 short-circuits without querying', async () => {
    expect(await fetchReplyChain('m1', 0, db)).toEqual([])
    expect(await fetchReplyChain('m1', -1, db)).toEqual([])
  })
})

describe('parseReplyChainDepth', () => {
  test('defaults to 10 when unset / invalid', () => {
    expect(parseReplyChainDepth(undefined)).toBe(10)
    expect(parseReplyChainDepth('')).toBe(10)
    expect(parseReplyChainDepth('NaN')).toBe(10)
    expect(parseReplyChainDepth('0')).toBe(10)
    expect(parseReplyChainDepth('-5')).toBe(10)
  })

  test('parses positive integers', () => {
    expect(parseReplyChainDepth('1')).toBe(1)
    expect(parseReplyChainDepth('25')).toBe(25)
  })
})
