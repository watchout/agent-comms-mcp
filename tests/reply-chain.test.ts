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
    // Issue #257 — light is default, so `preview` carries the body and
    // `content` is undefined unless mode='full' is requested.
    expect(chain[0].preview).toBe('first')
    expect(chain[chain.length - 1].preview).toBe('fourth')
    expect(chain[0].content).toBeUndefined()
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

// ============================================================
// PR-α cycle 1 fresh — §4 Source-pin tests (file content invariants)
// (lead-ama dispatch msg `00a40413`/`a424a8b0`/.../`54d168e7` + AMEND-1)
// ============================================================
describe('PR-α cycle 1 — §4 source-pin tests', () => {
  const repoRoot = new URL('..', import.meta.url).pathname
  const readFileSyncSafe = async (rel: string) => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    return readFileSync(join(repoRoot, rel), 'utf8')
  }

  // §4.1 spec §4.1 sample JSON が seed-inclusive (depth=0/1/2 entries, parent_id, preview, no content)
  test('§4.1 spec §4.1 sample JSON is seed-inclusive with parent_id/depth/preview, no content', async () => {
    const text = await readFileSyncSafe('docs/agent-com-message-queue-spec.md')
    // Locate §4.1 sample JSON block.
    const sampleSection = text.split('### 4.1 agent-com next')[1]?.split('### 4.2')[0] ?? ''
    expect(sampleSection).toContain('"reply_chain"')
    // Three depth levels including seed (0).
    expect(sampleSection).toContain('"depth": 0')
    expect(sampleSection).toContain('"depth": 1')
    expect(sampleSection).toContain('"depth": 2')
    expect(sampleSection).toContain('"parent_id"')
    expect(sampleSection).toContain('"preview"')
    // The §4.1 sample uses preview, not full content.
    const sampleReplyChain = sampleSection.split('"reply_chain": [')[1]?.split(']')[0] ?? ''
    expect(sampleReplyChain).not.toContain('"content"')
  })

  // §4.2 spec §18.1 interface comment が seed-inclusive 表記 + parent_id/depth/preview/expand_msg 契約あり
  test('§4.2 spec §18.1 interface block declares seed-inclusive + parent_id/depth/preview/ExpandMsgResponse', async () => {
    const text = await readFileSyncSafe('docs/agent-com-message-queue-spec.md')
    const section = text.split('### 18.1 Reply Chain Context')[1]?.split('### 18.2')[0] ?? ''
    expect(section).toContain('seed-inclusive')
    expect(section).toContain('parent_id')
    expect(section).toContain('depth')
    expect(section).toContain('preview')
    expect(section).toContain('ExpandMsgResponse')
    expect(section).not.toContain('reply_to 祖先')
    // AgentMessage[] (legacy) はもう使われない
    expect(section).not.toContain('AgentMessage[]')
  })

  // §4.3 docs/phase-c-redef-approval.md line 55-87 が seed-inclusive + default depth 5 + 「default break adopted」整合
  test('§4.3 phase-c-redef-approval is seed-inclusive + default 5 + default break adopted', async () => {
    const text = await readFileSyncSafe('docs/phase-c-redef-approval.md')
    expect(text).not.toContain('祖先のみ')
    expect(text).not.toContain('ancestor-only')
    expect(text).not.toContain('default: 10')
    expect(text).toContain('default: 5')
    expect(text).toMatch(/seed[- ]inclusive|seed.*含めて/)
    expect(text).toMatch(/default break adopted|default break/)
  })

  // §4.4 docs/SSOT.md is updated to new contract (cycle 2-revised §2.7a + §2.8)
  test('§4.4 docs/SSOT.md — cycle 2-revised §2.7a/§2.8 updated to new contract', async () => {
    const text = await readFileSyncSafe('docs/SSOT.md')
    // §3.7 merge gate: 0 hits of legacy keyword
    expect(text).not.toContain('check_inbox')
    // §2.8 negative pins (legacy artefacts must not remain)
    expect(text).not.toContain('No new messages')
    expect(text).not.toContain('シグナルファイル')
    // §2.8 positive pins (new contract keywords must be present)
    expect(text).toContain('expand_msg')
    expect(text).toMatch(/full\??:\s*boolean|\|\s*full\s*\|\s*boolean\s*\|/)
    expect(text).toContain('light/full')
    // §2.7a: max_depth=5 (was 10)
    expect(text).toContain('max_depth: 5')
    expect(text).not.toContain('max_depth: 10')
  })

  // §4.4b SSOT-3 API CONTRACT — cycle 2-revised §2.7b + §2.8 + §3.7 + cycle 3 minimal
  test('§4.4b SSOT-3_API_CONTRACT — new contract literal + grep gate (§3.7)', async () => {
    const text = await readFileSyncSafe('docs/design/core/SSOT-3_API_CONTRACT.md')
    // §3.7 merge gate: 0 hits of `^| to | string |` / `No new messages` / シグナルファイル / `to="channel:`
    expect(text).not.toMatch(/^\| to \| string \|/m)
    expect(text).not.toContain('No new messages')
    expect(text).not.toContain('シグナルファイル')
    expect(text).not.toContain('to="channel:')
    // cycle 3 minimal direct dispatch (msg `ec22cbfd`): SSOT-3 全 file 対象で
    // legacy `check_inbox` literal 不在 (line 186 rephrase 後の永続 pin)
    expect(text).not.toMatch(/check_inbox/)
    // §2.8 positive pins
    expect(text).toContain('expand_msg')
    // SSOT-3 declares the `full` arg in the inbox/next param tables (`| full | boolean |`)
    expect(text).toMatch(/\|\s*full\s*\|\s*boolean\s*\|/)
    expect(text).toContain('INVALID_ARG')
    expect(text).toContain('MSG_NOT_FOUND')
    expect(text).toContain('DB_UNAVAILABLE')
    expect(text).toContain('EXPAND_MSG_FAILED')
    // 深度制限 = 5 (was 10)
    expect(text).toContain('reply_chain の最大深度 | 5')
  })

  // §4.5 全 5 SSOT (code default / spec §19 / phase-c-redef / .env.example / cli/init.ts) で depth=5 整合
  //      + AMEND-1: .env.example / cli/init.ts に AGENT_COM_REPLY_CHAIN_MODE=full opt-back commented 行
  test('§4.5 cross-file SSOT — depth=5 across 5 files + opt-back commented in user-facing template', async () => {
    const code = await readFileSyncSafe('core/reply-chain.ts')
    const spec = await readFileSyncSafe('docs/agent-com-message-queue-spec.md')
    const init = await readFileSyncSafe('cli/init.ts')
    const env = await readFileSyncSafe('.env.example')
    const phaseC = await readFileSyncSafe('docs/phase-c-redef-approval.md')
    expect(code).toContain('REPLY_CHAIN_DEFAULT_DEPTH = 5')
    expect(spec).toContain('default: 5')
    expect(init).toContain('AGENT_COM_REPLY_CHAIN_DEPTH=5')
    expect(env).toContain('AGENT_COM_REPLY_CHAIN_DEPTH=5')
    expect(phaseC).toContain('default: 5')
    // AMEND-1 §3.5 + §4.5 — opt-back env exposed (commented) in user-facing
    // template so users discover the legacy CLI path without reading docs.
    expect(env).toContain('# AGENT_COM_REPLY_CHAIN_MODE=full')
    expect(init).toContain('AGENT_COM_REPLY_CHAIN_MODE=full')
  })

  // AMEND-1 §4.11 — run-bot loop detection 互換 source-pin (B8 v0.2 refactor)
  test('§4.11 run-bot loop detection — light shape preserves `.from`, scripts/run-bot.sh delegates to loop-detector helper', async () => {
    // Light mode primitive must retain `.from`.
    await insert('m1', 'alice', 'one', null, '2026-04-30T00:00:00Z')
    await insert('m2', 'bob', 'two', 'm1', '2026-04-30T00:00:01Z')
    const chain = await fetchReplyChain('m2', 5, db) // light default
    for (const entry of chain) {
      expect(typeof entry.from).toBe('string')
      expect(entry.from.length).toBeGreaterThan(0)
      expect(entry.content).toBeUndefined() // light, no content
    }
    // B8 amendment v0.2 §2.5 — detector logic moved to
    // `scripts/lib/loop-detector.ts`; run-bot.sh is the thin caller
    // that piles the reply_chain JSON into the bun helper. The
    // light-shape `.from` field is still what the helper reads, and
    // the run-bot script still references `.reply_chain` (now via
    // `--argjson chain "$reply_chain"` in the jq composer for the
    // helper input). Pin both.
    const runbot = await readFileSyncSafe('scripts/run-bot.sh')
    expect(runbot).toContain('reply_chain')
    expect(runbot).toContain('scripts/lib/loop-detector-cli.ts')
  })
})

describe('PR-α cycle 1 — §4 behavioral fixtures (light/full mode primitive)', () => {
  test('light default — reply_chain entries have preview, parent_id, depth; no content', async () => {
    await insert('m1', 'a', 'one full body that is meaningfully longer than the preview', null, '2026-04-30T00:00:00Z')
    await insert('m2', 'b', 'two full body also longer than preview', 'm1', '2026-04-30T00:00:01Z')
    const chain = await fetchReplyChain('m2', 5, db)
    expect(chain.length).toBe(2)
    for (const entry of chain) {
      expect(entry.content).toBeUndefined()
      expect(typeof entry.preview).toBe('string')
      expect(entry.preview.length).toBeGreaterThan(0)
      expect(entry.preview.length).toBeLessThanOrEqual(80)
      expect('parent_id' in entry).toBe(true)
      expect(typeof entry.depth).toBe('number')
    }
    // depth is from-seed: m2 is seed (depth 0), m1 is ancestor (depth 1).
    const m1 = chain.find((e) => e.id === 'm1')!
    const m2 = chain.find((e) => e.id === 'm2')!
    expect(m2.depth).toBe(0)
    expect(m1.depth).toBe(1)
    expect(m2.parent_id).toBe('m1')
    expect(m1.parent_id).toBeNull()
  })

  test('full mode — every entry carries content AND preview', async () => {
    const longBody = 'X'.repeat(150)
    await insert('m1', 'a', longBody, null, '2026-04-30T00:00:00Z')
    await insert('m2', 'b', longBody, 'm1', '2026-04-30T00:00:01Z')
    const chain = await fetchReplyChain('m2', 5, db, 'full')
    expect(chain.length).toBe(2)
    for (const entry of chain) {
      expect(entry.content).toBe(longBody)
      expect(entry.preview.length).toBe(80)
    }
  })
})
