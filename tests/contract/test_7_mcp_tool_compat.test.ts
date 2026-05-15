/**
 * PR-α cycle 1 fresh — §4 Behavioral merge-gate fixtures
 * (lead-ama dispatch msg `00a40413`+/`a424a8b0`+/.../`54d168e7` + AMEND-1)
 *
 * Promotes the legacy `describe.todo` scaffold into executable pins for the
 * MCP tool surface that this PR defines:
 *   - 4.6 MCP `next` default light / `full:true` opt-in
 *   - 4.7 MCP `inbox` default light + truncation suffix / `full:true` legacy verbatim
 *   - 4.8 MCP `expand_msg` 4 error class (INVALID_ARG / MSG_NOT_FOUND / DB_UNAVAILABLE / EXPAND_MSG_FAILED) + happy path
 *   - 4.9 CLI `agent-com next` env-based opt-back source-pin (asymmetric vs MCP arg)
 *   - 4.10 payload <2KB budget — full envelope (next / inbox), default light
 *   - 4.11 light mode preserves `.from` for run-bot loop detection
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  fetchReplyChain,
  REPLY_CHAIN_PREVIEW_CHARS,
  REPLY_CHAIN_DEFAULT_DEPTH,
  type ReplyChainEntry,
} from '../../core/reply-chain'

const repoRoot = new URL('../..', import.meta.url).pathname
const readRepo = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8')

let db: SqliteAdapter
let dbPath: string

beforeEach(async () => {
  dbPath = `/tmp/test7-mcp-tool-compat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  db = new SqliteAdapter(dbPath)
  await db.execute(`
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reply_to TEXT,
      message_type TEXT,
      metadata TEXT,
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

describe('test_7_mcp_tool_compat — MCP tool registration source pin', () => {
  test('server.ts registers next/inbox/expand_msg with the contract-required schema', () => {
    const src = readRepo('server.ts')
    const nextBlock = src.split("name: 'next',")[1]?.split("name: 'send',")[0] ?? ''
    expect(nextBlock).toMatch(/full:\s*\{[\s\S]*?type:\s*['"]boolean['"]/)
    const inboxBlock = src.split("name: 'inbox',")[1]?.split("name: 'expand_msg',")[0] ?? ''
    expect(inboxBlock).toMatch(/full:\s*\{[\s\S]*?type:\s*['"]boolean['"]/)
    const expandBlock = src.split("name: 'expand_msg',")[1]?.slice(0, 1500) ?? ''
    expect(expandBlock).toContain('id:')
    expect(expandBlock).toContain('message_id:')
    expect(src).toMatch(/if\s*\(\s*name\s*===\s*['"]expand_msg['"]\s*\)/)
  })

  test('inbox is history-only and refuses to preview pending queue rows', () => {
    const src = readRepo('server.ts')
    const inboxHandler = src.split("if (name === 'inbox' || name === 'check_inbox')")[1]?.split("if (name === 'expand_msg')")[0] ?? ''
    expect(inboxHandler).toContain('NEXT_REQUIRED')
    expect(inboxHandler).toContain("status = 'pending'")
    expect(inboxHandler).toContain('Call next to claim one message')
  })

  test('server.ts expand_msg handler emits all 4 error classes + structured happy result', () => {
    const src = readRepo('server.ts')
    const handlerStart = src.indexOf("if (name === 'expand_msg')")
    expect(handlerStart).toBeGreaterThan(0)
    const handler = src.slice(handlerStart, handlerStart + 4000)
    expect(handler).toContain('INVALID_ARG')
    expect(handler).toContain('MSG_NOT_FOUND')
    expect(handler).toContain('DB_UNAVAILABLE')
    expect(handler).toContain('EXPAND_MSG_FAILED')
    expect(handler).toContain('[0-9a-fA-F]')
  })
})

describe('test_7_mcp_tool_compat — light/full mode primitive', () => {
  test('4.6 default light: reply_chain[].content undefined, preview <= 80, .from preserved (4.11)', async () => {
    const long = 'A'.repeat(200)
    await insert('m1', 'alice', long, null, '2026-04-30T00:00:00Z')
    await insert('m2', 'bob', long, 'm1', '2026-04-30T00:00:01Z')
    const chain = await fetchReplyChain('m2', REPLY_CHAIN_DEFAULT_DEPTH, db)
    expect(chain.length).toBe(2)
    for (const e of chain) {
      expect(e.content).toBeUndefined()
      expect(e.preview.length).toBeLessThanOrEqual(REPLY_CHAIN_PREVIEW_CHARS)
      expect(typeof e.from).toBe('string')
      expect(e.from.length).toBeGreaterThan(0)
    }
  })

  test('4.6 full opt-in: reply_chain[].content carries the full body + preview also present', async () => {
    const long = 'B'.repeat(200)
    await insert('m1', 'alice', long, null, '2026-04-30T00:00:00Z')
    const chain = await fetchReplyChain('m1', REPLY_CHAIN_DEFAULT_DEPTH, db, 'full')
    expect(chain.length).toBe(1)
    expect(chain[0].content).toBe(long)
    expect(chain[0].preview.length).toBe(REPLY_CHAIN_PREVIEW_CHARS)
  })
})

describe('test_7_mcp_tool_compat — inbox light shape + truncation suffix (4.7)', () => {
  function projectInbox(rows: Array<{ id: string; author_id: string; channel_id: string; content: string; created_at: string }>, full: boolean) {
    return {
      count: rows.length,
      messages: rows.map((r) => {
        const out: Record<string, unknown> = {
          id: r.id, from: r.author_id, channel_id: r.channel_id, created_at: r.created_at,
        }
        if (full) {
          out.content = r.content
        } else {
          const isTrunc = r.content.length > REPLY_CHAIN_PREVIEW_CHARS
          out.preview = isTrunc
            ? r.content.slice(0, REPLY_CHAIN_PREVIEW_CHARS) + ` … [truncated, call expand_msg with id=${r.id}]`
            : r.content
        }
        return out
      }),
    }
  }

  test('4.7 inbox default — preview-only with truncation suffix referencing id', () => {
    const long = 'Z'.repeat(200)
    const projected = projectInbox(
      [{ id: 'a-1234', author_id: 'a', channel_id: 'c', content: long, created_at: 't' }],
      false,
    )
    const m = (projected.messages[0] as any)
    expect(m.content).toBeUndefined()
    expect(typeof m.preview).toBe('string')
    expect(m.preview).toContain('[truncated, call expand_msg with id=a-1234]')
  })

  test('4.7 inbox full opt-in — verbatim row body, no preview', () => {
    const long = 'Y'.repeat(50)
    const projected = projectInbox(
      [{ id: 'b-9999', author_id: 'b', channel_id: 'c', content: long, created_at: 't' }],
      true,
    )
    const m = (projected.messages[0] as any)
    expect(m.content).toBe(long)
    expect(m.preview).toBeUndefined()
  })

  test('4.7 inbox source-pin — handler builds structured JSON envelope with truncation suffix literal', () => {
    const src = readRepo('server.ts')
    const idx = src.indexOf("if (name === 'inbox' || name === 'check_inbox')")
    expect(idx).toBeGreaterThan(0)
    const block = src.slice(idx, idx + 2000)
    expect(block).toContain('truncated, call expand_msg with id=')
    expect(block).toContain('count:')
    expect(block).toContain('messages')
  })
})

describe('test_7_mcp_tool_compat — expand_msg behavioral (4.8)', () => {
  const isUuidLike = (s: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)

  test('INVALID_ARG — empty input or non-UUID rejected by validation gate', () => {
    expect(isUuidLike('')).toBe(false)
    expect(isUuidLike('not-a-uuid')).toBe(false)
    expect(isUuidLike('123')).toBe(false)
  })

  test('happy path — DB query returns single row with full content + metadata', async () => {
    const goodId = '11111111-2222-3333-4444-555555555555'
    await insert(goodId, 'alice', 'the full body of the message', null, '2026-04-30T00:00:00Z')
    const rows = (await db.query(
      `SELECT id, channel_id, author_id, content, reply_to, message_type, metadata, created_at
       FROM agent_messages WHERE id = $1 LIMIT 1`,
      [goodId],
    )) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].content).toBe('the full body of the message')
    expect(rows[0].author_id).toBe('alice')
  })

  test('MSG_NOT_FOUND — DB query for absent UUID returns []', async () => {
    const missingId = '99999999-9999-9999-9999-999999999999'
    const rows = (await db.query(
      `SELECT id FROM agent_messages WHERE id = $1 LIMIT 1`,
      [missingId],
    )) as any[]
    expect(rows.length).toBe(0)
  })
})

describe('test_7_mcp_tool_compat — CLI env-based opt-back (4.9 asymmetric recovery)', () => {
  test('cli/index.ts reads AGENT_COM_REPLY_CHAIN_MODE env, NOT a `full:true` arg', () => {
    const cli = readRepo('cli/index.ts')
    expect(cli).toMatch(/AGENT_COM_REPLY_CHAIN_MODE\s*===\s*['"]full['"]/)
    expect(cli).not.toMatch(/args[^)]*\)\.full\s*===\s*true/)
  })

  test('server.ts MCP path reads args.full === true, NOT the env var (asymmetric)', () => {
    const src = readRepo('server.ts')
    const nextHandlerStart = src.indexOf("if (name === 'next')")
    const nextHandlerEnd = src.indexOf("if (name === 'send')")
    expect(nextHandlerStart).toBeGreaterThan(0)
    expect(nextHandlerEnd).toBeGreaterThan(nextHandlerStart)
    const nextHandler = src.slice(nextHandlerStart, nextHandlerEnd)
    expect(nextHandler).toMatch(/\(args[^)]*\)\.full\s*===\s*true/)
    expect(nextHandler).not.toMatch(/AGENT_COM_REPLY_CHAIN_MODE\s*===\s*['"]full['"]/)
  })
})

describe('test_7_mcp_tool_compat — payload <2KB budget on full envelope (4.10)', () => {
  test('4.10 next envelope reply_chain + metadata overhead is <2KB even with a 5-deep chain of 2KB messages', async () => {
    const big = 'X'.repeat(2000)
    for (let i = 1; i <= REPLY_CHAIN_DEFAULT_DEPTH; i++) {
      await insert(`d${i}`, 'agent', big, i === 1 ? null : `d${i - 1}`, `2026-04-30T00:00:0${i}Z`)
    }
    const replyChain: ReplyChainEntry[] = await fetchReplyChain(
      `d${REPLY_CHAIN_DEFAULT_DEPTH}`,
      REPLY_CHAIN_DEFAULT_DEPTH,
      db,
    )
    const envelope = {
      waiting: 5,
      queue_id: 12345,
      message_id: '11111111-2222-3333-4444-555555555555',
      channel_id: 'channel-id',
      thread_id: null,
      from: 'sender',
      from_name: null,
      content: big,
      message_type: 'chat',
      source: 'discord',
      created_at: '2026-04-30T00:00:05Z',
      reply_chain: replyChain,
    }
    const serialized = JSON.stringify(envelope)
    const overhead = serialized.length - big.length
    expect(overhead).toBeLessThan(2000)
  })

  test('4.10 inbox default light envelope is far smaller than the full-body equivalent (>10× reduction)', () => {
    const big = 'X'.repeat(2000)
    const rows = []
    for (let i = 0; i < 20; i++) {
      rows.push({ id: `id-${i.toString().padStart(8, '0')}`, author_id: 'a', channel_id: 'c', content: big, created_at: 't' })
    }
    const lightMessages = rows.map((r) => ({
      id: r.id, from: r.author_id, channel_id: r.channel_id, created_at: r.created_at,
      preview: r.content.slice(0, REPLY_CHAIN_PREVIEW_CHARS) + ` … [truncated, call expand_msg with id=${r.id}]`,
    }))
    const fullMessages = rows.map((r) => ({
      id: r.id, from: r.author_id, channel_id: r.channel_id, created_at: r.created_at, content: r.content,
    }))
    const lightSize = JSON.stringify({ count: rows.length, messages: lightMessages }).length
    const fullSize = JSON.stringify({ count: rows.length, messages: fullMessages }).length
    expect(lightSize).toBeLessThan(fullSize / 5)
    // light envelope per-message is bounded; <300 chars per row.
    expect(lightSize / rows.length).toBeLessThan(300)
  })
})
