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
  test('reply chain includes seed (current message) + ancestors, oldest-first', async () => {
    await insert('m1', 'alice', 'first',  null, '2026-04-18T00:00:00Z')
    await insert('m2', 'bob',   'second', 'm1', '2026-04-18T00:00:01Z')
    await insert('m3', 'alice', 'third',  'm2', '2026-04-18T00:00:02Z')
    await insert('m4', 'bob',   'fourth', 'm3', '2026-04-18T00:00:03Z')

    const chain = await fetchReplyChain('m4', 10, db)
    // Seed row (m4) is the last entry; ancestors come before it, oldest-first.
    // spec §18.1 `$current_message_id` semantics — caller gets the full
    // conversation thread in one object.
    expect(chain.map((e) => e.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(chain.map((e) => e.from)).toEqual(['alice', 'bob', 'alice', 'bob'])
    expect(chain[0].content).toBe('first')
    expect(chain[chain.length - 1].content).toBe('fourth')
  })

  test('seed-only message (reply_to = NULL) returns just the seed', async () => {
    await insert('m1', 'alice', 'solo', null, '2026-04-18T00:00:00Z')
    const chain = await fetchReplyChain('m1', 10, db)
    expect(chain.map((e) => e.id)).toEqual(['m1'])
  })

  test('returns [] when messageId is null/undefined', async () => {
    expect(await fetchReplyChain(null, 10, db)).toEqual([])
    expect(await fetchReplyChain(undefined, 10, db)).toEqual([])
  })

  test('depth limit stops traversal and prevents infinite loop on cycles', async () => {
    // a → b → a (direct cycle)
    await insert('a', 'x', 'A', 'b', '2026-04-18T00:00:00Z')
    await insert('b', 'y', 'B', 'a', '2026-04-18T00:00:01Z')

    const chain = await fetchReplyChain('a', 3, db)
    // With depth=3 the CTE emits up to 3 rows; the important invariant is
    // that the query TERMINATES — that's the cycle guard.
    expect(chain.length).toBeLessThanOrEqual(3)
  })

  test('caller-supplied depth caps the walk at N levels including seed', async () => {
    // 5-deep linear chain (m1 ← m2 ← m3 ← m4 ← m5)
    await insert('m1', 'a', '1',  null, '2026-04-18T00:00:00Z')
    await insert('m2', 'b', '2', 'm1', '2026-04-18T00:00:01Z')
    await insert('m3', 'a', '3', 'm2', '2026-04-18T00:00:02Z')
    await insert('m4', 'b', '4', 'm3', '2026-04-18T00:00:03Z')
    await insert('m5', 'a', '5', 'm4', '2026-04-18T00:00:04Z')

    const chain = await fetchReplyChain('m5', 2, db)
    // depth=2 → CTE emits seed + 1 ancestor = 2 rows total.
    expect(chain.map((e) => e.id)).toEqual(['m4', 'm5'])
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
  test('defaults to 5 when unset / invalid (spec §19)', () => {
    expect(parseReplyChainDepth(undefined)).toBe(5)
    expect(parseReplyChainDepth('')).toBe(5)
    expect(parseReplyChainDepth('NaN')).toBe(5)
    expect(parseReplyChainDepth('0')).toBe(5)
    expect(parseReplyChainDepth('-5')).toBe(5)
  })

  test('parses positive integers', () => {
    expect(parseReplyChainDepth('1')).toBe(1)
    expect(parseReplyChainDepth('25')).toBe(25)
  })
})

// --- Integration-style test: next-response shape ---
// Pins that fetchReplyChain, when fed the current message_id the way
// server.ts / cli/index.ts now do, returns the FULL chain (current message
// + ancestors). This guards the cycle 1 BLOCK regression (auditor msg
// 1494972320) where caller was passing payload.reply_to instead of the
// current message_id, dropping the direct parent from the chain.
describe('next-handler integration — reply_chain seed is current message', () => {
  test('seed = current message_id yields current + all reachable ancestors', async () => {
    // Simulate: three-message conversation where m3 is the row that `next`
    // just popped; payload.message_id === 'm3', payload.reply_to === 'm2'.
    await insert('m1', 'alice', 'Q?',      null, '2026-04-18T00:00:00Z')
    await insert('m2', 'bob',   'A1',     'm1', '2026-04-18T00:00:01Z')
    await insert('m3', 'alice', 'follow', 'm2', '2026-04-18T00:00:02Z')

    // The server / CLI now pass `row.message_id ?? payload.message_id`.
    const chain = await fetchReplyChain('m3', 5, db)
    expect(chain.map((e) => e.id)).toEqual(['m1', 'm2', 'm3'])
    // The direct parent (m2) MUST be present — that was the cycle 1 BLOCK.
    expect(chain.find((e) => e.id === 'm2')).toBeDefined()
    // The current message itself MUST be present (spec §18.1 canonical).
    expect(chain.find((e) => e.id === 'm3')).toBeDefined()
  })

  test('passing reply_to (old wrong behaviour) would drop current message', async () => {
    // This is the regression guard. If a future refactor accidentally goes
    // back to seeding with `payload.reply_to`, the current message gets
    // dropped. We pin the *correct* behaviour explicitly.
    await insert('m1', 'alice', 'Q?',  null, '2026-04-18T00:00:00Z')
    await insert('m2', 'bob',   'A',  'm1', '2026-04-18T00:00:01Z')
    await insert('m3', 'alice', 'hm', 'm2', '2026-04-18T00:00:02Z')

    const wrongChain = await fetchReplyChain('m2', 5, db) // seeded with reply_to
    expect(wrongChain.map((e) => e.id)).toEqual(['m1', 'm2']) // m3 missing
    const rightChain = await fetchReplyChain('m3', 5, db) // seeded with current
    expect(rightChain.map((e) => e.id)).toEqual(['m1', 'm2', 'm3']) // all present
  })
})
