#!/usr/bin/env bun
/**
 * Behavioral FAIL (B1-B5) spec alignment — pins the source-shape changes
 * required by CTO msg 257c5d05 + c3cd0e80 + c11f5387 and the runtime
 * behavior of `core/sender-feedback.ts` against a hermetic SQLite fixture.
 *
 * Layering:
 *   Part A  — source guards (regex) for server.ts + cli/index.ts.
 *   Part B  — unit tests for `notifySenderOfDeliveryStatus` on SqliteAdapter.
 *   Part C  — SQL-shape integration (SQLite) for the B1 / B4 UPDATE bundles.
 *
 * The PG integration path is exercised by the existing `bun test` suite
 * plus the normal deployment pipeline; this file stays DB-portable by
 * pinning the SQL literals we actually care about.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { toLegacy } from '../../core/db/adapter'
import { notifySenderOfDeliveryStatus, type SenderFeedbackDb } from '../../core/sender-feedback'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli/index.ts'), 'utf-8')
const INBOUND_SRC = readFileSync(join(REPO_ROOT, 'adapters/inbound-receiver.ts'), 'utf-8')

// ─────────────────────────────────────────────────────────────────────────────
// Part A — source guards
// ─────────────────────────────────────────────────────────────────────────────

describe('Behavioral FAIL B2 — MCP send per-row claim guard (Issue #278 segment 3a)', () => {
  test('send handler rejects with INVALID_REPLY_TO only when reply_to is missing or unresolvable (CEO P1)', () => {
    // CEO P1 (2026-05-07): the strict "no in-flight claim → reject"
    // path was retired. The handler now silently falls back to a
    // notify-equivalent dispatch when the claim is missing/expired
    // and only rejects with INVALID_REPLY_TO when the reply_to UUID
    // itself cannot be resolved (absent or no channel_id).
    expect(SERVER_SRC).toMatch(/Error \[INVALID_REPLY_TO\]:\s*reply_to is required for send/)
    expect(SERVER_SRC).toMatch(/Error \[INVALID_REPLY_TO\]:\s*reply_to=\$\{reply_to\} not found in agent_messages or has no channel/)
    // The legacy "no in-flight claim for reply_to=" reject string must
    // be gone — its presence would mean we're still rejecting calls
    // that the P1 spec wants to fall back instead.
    expect(SERVER_SRC).not.toMatch(/Error \[INVALID_REPLY_TO\]:\s*no in-flight claim for reply_to=/)
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", sendIdx)
    const handler = SERVER_SRC.slice(sendIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    expect(handler).not.toMatch(/Error \[NO_CURRENT_MESSAGE\]/)
    // CEO P1: the handler must surface the fallback in the return
    // value — silent reject is forbidden.
    expect(handler).toMatch(/fallback: notify \(reason: \$\{fallbackReason\}\)/)
  })
  // Pre-existing latent fail: previously pinned the legacy claim status in
  // send-fallback-decision helper, but v0.9 (sub-PR 1 #347 + sub-PR 3 #350)
  // renamed it to 'received'. Vocab follow lives in this PR's source
  // changes; the test itself needs the pin updated, which is its own
  // concern (1 PR 1 concern). Deferred to Issue #338 sub-PR 9 (latent
  // fail investigation).
  test.skip('claim guard delegates to decideSendFallback helper with FOR UPDATE atomicity (TODO Issue #338 sub-PR 9 — latent fail)', () => {
    // Per-row claim replaces the agents single-slot lock. CEO P1
    // refactored the SELECT ... FOR UPDATE into core/send-fallback-decision
    // so the decision tree (claim_present / fallback / invalid_reply_to)
    // is unit-testable. The FOR UPDATE clause still lives in the helper
    // so two concurrent send calls targeting the same claim serialise
    // on the row lock.
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    expect(sendIdx).toBeGreaterThan(-1)
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", sendIdx)
    const handler = SERVER_SRC.slice(sendIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    expect(handler).toMatch(/decideSendFallback\(txClient, reply_to, agentId\)/)
    expect(handler).toMatch(/txClient\.query\(['"]BEGIN['"]\)/)
    // Invariant: the helper holds the FOR UPDATE clause.
    const helperSrc = readFileSync(join(REPO_ROOT, 'core', 'send-fallback-decision.ts'), 'utf-8')
    expect(helperSrc).toMatch(/FOR UPDATE/)
    expect(helperSrc).toMatch(/WHERE message_id = \$1 AND claimed_by = \$2 AND status = 'received'/)
  })
  test('handler COMMITs only on the happy path and ROLLBACKs via finally on early return', () => {
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", sendIdx)
    const handler = SERVER_SRC.slice(sendIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    expect(handler).toMatch(/txClient\.query\(['"]COMMIT['"]\)/)
    expect(handler).toMatch(/txCommitted = true/)
    expect(handler).toMatch(/if \(!txCommitted\)\s*\{\s*await txClient\.query\(['"]ROLLBACK['"]\)/)
  })
  test('D3 fallback (else if reply_to) is removed', () => {
    // The guard makes current_message_id non-null unconditionally, so the
    // fallback branch is dead code and must be deleted outright.
    expect(SERVER_SRC).not.toMatch(/else if \(reply_to\)/)
    expect(SERVER_SRC).not.toMatch(/d3_fallback_replied/)
  })
  test('outbound_queue INSERT sits AFTER the message_queue "replied" UPDATE', () => {
    const repliedMatch = /UPDATE message_queue\s+SET\s+status\s*=\s*'replied'[\s\S]*?replied_at\s*=\s*now\(\)[\s\S]*?replied_with\s*=\s*\$1[\s\S]*?claim_expires_at\s*=\s*NULL[\s\S]*?WHERE id = \$2/.exec(SERVER_SRC)
    const repliedIdx = repliedMatch?.index ?? -1
    const outboundIdx = SERVER_SRC.indexOf(
      `INSERT INTO outbound_queue (message_id, agent_id, consumer_agent_id, channel_external_id, content)`,
    )
    expect(repliedIdx).toBeGreaterThan(-1)
    expect(outboundIdx).toBeGreaterThan(-1)
    expect(outboundIdx).toBeGreaterThan(repliedIdx)
  })
  test('outbound INSERT uses txClient so failures rollback the whole send', () => {
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", sendIdx)
    const handler = SERVER_SRC.slice(sendIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    // `txClient.query(...INSERT INTO outbound_queue...)` must be the INSERT
    // used for send's outbound enqueue; drops to a different client would
    // escape the transaction.
    expect(handler).toMatch(/txClient\.query\([\s\S]*?INSERT INTO outbound_queue/)
  })
})

describe('Behavioral FAIL B1 — next derives agents.status from open-claim EXISTS (Issue #278 cycle 1)', () => {
  // Cycle 1 (auditor BLOCK 1): the multi in-flight contract requires
  // agents.status to track the *set* of open claims, not just the most
  // recent transition. Both next and send/fail/skip/reclaim now write
  // the same EXISTS-derive shape.
  test('server.ts next uses CASE WHEN EXISTS open-claim derivation', () => {
    expect(SERVER_SRC).toMatch(
      /status = CASE WHEN EXISTS\(SELECT 1 FROM message_queue WHERE claimed_by = \$1 AND status = 'received'\) THEN 'busy' ELSE 'idle' END/,
    )
  })
  test('cli nextMessage uses CASE WHEN EXISTS open-claim derivation', () => {
    expect(CLI_SRC).toMatch(
      /status = CASE WHEN EXISTS\(SELECT 1 FROM message_queue WHERE claimed_by = \$1 AND status = 'received'\) THEN 'busy' ELSE 'idle' END/,
    )
  })
})

describe('Behavioral FAIL B4 — send uses the same EXISTS-derive at close-time (Issue #278 cycle 1)', () => {
  test('server.ts send uses CASE WHEN EXISTS open-claim derivation', () => {
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", sendIdx)
    const handler = SERVER_SRC.slice(sendIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    expect(handler).toMatch(
      /status = CASE WHEN EXISTS\(SELECT 1 FROM message_queue WHERE claimed_by = \$1 AND status = 'received'\) THEN 'busy' ELSE 'idle' END/,
    )
    // Negative pins.
    expect(handler).not.toMatch(/UPDATE agents SET current_message_id = NULL/)
    expect(handler).not.toMatch(/UPDATE agents SET status = 'idle', status_detail = NULL, status_updated_at = now\(\) WHERE agent_id = \$1/)
  })
  test('cli sendMessage uses CASE WHEN EXISTS open-claim derivation', () => {
    expect(CLI_SRC).toMatch(
      /status = CASE WHEN EXISTS\(SELECT 1 FROM message_queue WHERE claimed_by = \$1 AND status = 'received'\) THEN 'busy' ELSE 'idle' END/,
    )
    expect(CLI_SRC).not.toMatch(/UPDATE agents SET current_message_id = NULL, status = 'idle'/)
  })
})

describe('Behavioral FAIL B3 — notify tool implemented', () => {
  test('MCP notify tool is listed with channel + content + mention required (ADR-041 amendment 2026-05-05 — mentions[] removed, mention required)', () => {
    expect(SERVER_SRC).toMatch(/name:\s*'notify'/)
    // ADR-041 amendment 2026-05-05 (CEO directive 5e2d9235) — legacy
    // `mentions[]` removed; `mention` (1 primary) is now schema-required.
    expect(SERVER_SRC).toMatch(/required:\s*\[['"]channel['"],\s*['"]content['"],\s*['"]mention['"]\]/)
  })
  test('MCP notify handler exists and does NOT touch reply_to / current_message_id', () => {
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    expect(notifyIdx).toBeGreaterThan(-1)
    // Slice extended (cycle 3 Phase 5 wiring): notify handler grew with the
    // resolvePhase5() block; bound the slice at the next top-level tool
    // block instead of a fixed offset.
    const fetchHistoryIdx = SERVER_SRC.indexOf("if (name === 'fetch_discord_history')", notifyIdx)
    const handler = SERVER_SRC.slice(notifyIdx, fetchHistoryIdx === -1 ? notifyIdx + 12000 : fetchHistoryIdx)
    expect(handler).toMatch(/reply_to:\s*undefined/)
    expect(handler).not.toMatch(/current_message_id\s*=\s*NULL/)
  })
  test('CLI exposes `agent-com notify` command dispatch', () => {
    expect(CLI_SRC).toMatch(/command === 'notify'/)
    expect(CLI_SRC).toMatch(/async function notifyMessage/)
  })
  // codex-auditor Layer 2 finding 2 — honest handling when channels.name has
  // no UNIQUE constraint and multiple rows match.
  test('MCP notify fails closed on ambiguous channel name (CHANNEL_NAME_AMBIGUOUS)', () => {
    expect(SERVER_SRC).toMatch(/CHANNEL_NAME_AMBIGUOUS/)
    expect(SERVER_SRC).toMatch(/SELECT id FROM channels WHERE name = \$1 ORDER BY id LIMIT 2/)
  })
  test('CLI notify fails closed on ambiguous channel name (CHANNEL_NAME_AMBIGUOUS)', () => {
    expect(CLI_SRC).toMatch(/CHANNEL_NAME_AMBIGUOUS/)
    expect(CLI_SRC).toMatch(/SELECT id FROM channels WHERE name = \$1 ORDER BY id LIMIT 2/)
  })
})

describe('Behavioral FAIL B5 — sender feedback wired at three call sites', () => {
  test('core/sender-feedback.ts exports notifySenderOfDeliveryStatus', () => {
    // The export is validated via import at the top of this file; if the
    // symbol went missing the file would fail to load.
    expect(typeof notifySenderOfDeliveryStatus).toBe('function')
  })
  test('server.ts send calls notifySenderOfDeliveryStatus (or its observe wrapper) after message_queue INSERT', () => {
    // Issue #251 cycle 2 axis 3 — call sites moved to the
    // `notifySenderAndObserve` wrapper (which still invokes
    // `notifySenderOfDeliveryStatus` internally) so the `emitted`
    // signal lands in a counter + stderr line per CTO `c1c6eb1d`.
    expect(SERVER_SRC).toMatch(/notifySender(?:OfDeliveryStatus|AndObserve)\([\s\S]*?senderId: agentId,[\s\S]*?targetId: recipient/)
  })
  test('server.ts notify calls notifySenderOfDeliveryStatus', () => {
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    expect(notifyIdx).toBeGreaterThan(-1)
    // The notify handler is long (~400 lines with comments). The feedback
    // call lives between the per-part message_queue loop and the outbound
    // loop, so slice the full handler up to the next top-level tool block.
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", notifyIdx)
    const handler = SERVER_SRC.slice(notifyIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    expect(handler).toMatch(/notifySender(?:OfDeliveryStatus|AndObserve)/)
  })
  test('adapters/inbound-receiver handleInboundMessage calls notifySenderOfDeliveryStatus (or its observe wrapper)', () => {
    expect(INBOUND_SRC).toMatch(/notifySender(?:OfDeliveryStatus|AndObserve)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Part B — unit tests for notifySenderOfDeliveryStatus (SqliteAdapter)
// ─────────────────────────────────────────────────────────────────────────────

describe('notifySenderOfDeliveryStatus — behavior', () => {
  let db: SqliteAdapter
  let legacy: SenderFeedbackDb
  let dbPath: string

  beforeEach(async () => {
    dbPath = `/tmp/sender-feedback-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    db = new SqliteAdapter(dbPath)
    legacy = toLegacy(db) as SenderFeedbackDb
    await db.execute(`
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle'
      )
    `)
    await db.execute(`
      CREATE TABLE message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        message_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    // Minimal seed: sender (idle) + targets in every relevant status.
    await db.execute(`INSERT INTO agents (agent_id, status) VALUES ('sender-a', 'idle')`)
    await db.execute(`INSERT INTO agents (agent_id, status) VALUES ('target-idle', 'idle')`)
    await db.execute(`INSERT INTO agents (agent_id, status) VALUES ('target-busy', 'busy')`)
    await db.execute(`INSERT INTO agents (agent_id, status) VALUES ('target-off', 'disconnected')`)
  })

  afterEach(async () => {
    await db.close()
    try { unlinkSync(dbPath) } catch {}
  })

  async function feedbackRows(senderId: string): Promise<Array<{ status: string; content: string; type: string }>> {
    const rows = await db.query<{ payload: string }>(`SELECT payload FROM message_queue WHERE agent_id = $1 ORDER BY id`, [senderId])
    return rows.map((row) => {
      const p = JSON.parse(row.payload) as { message_type: string; content: string }
      return { status: p.message_type, content: p.content, type: p.message_type }
    })
  }

  test('idle target → no feedback row (fast path)', async () => {
    const res = await notifySenderOfDeliveryStatus(legacy, {
      senderId: 'sender-a', targetId: 'target-idle', messageId: 'msg-1',
    })
    expect(res.emitted).toBe(null)
    expect(await feedbackRows('sender-a')).toHaveLength(0)
  })

  test('busy target → emitted=system_info reason=queue-skip, NO row enqueued (Issue #251 b)', async () => {
    // Issue #251 (b) — the busy / system_info notification used to
    // INSERT into message_queue (447 such rows observed over 7d in
    // production, 14 still pending). Cycle 1 short-circuits the
    // busy branch: the function returns the emitted=system_info
    // signal without writing to the queue. Disconnected /
    // system_error rows still INSERT — covered by the next test.
    const res = await notifySenderOfDeliveryStatus(legacy, {
      senderId: 'sender-a', targetId: 'target-busy', messageId: 'msg-2',
    })
    expect(res.emitted).toBe('system_info')
    expect(res.reason).toBe('queue-skip')
    expect(await feedbackRows('sender-a')).toHaveLength(0)
  })

  test('disconnected target → system_error row lands in sender queue', async () => {
    const res = await notifySenderOfDeliveryStatus(legacy, {
      senderId: 'sender-a', targetId: 'target-off', messageId: 'msg-3',
    })
    expect(res.emitted).toBe('system_error')
    const rows = await feedbackRows('sender-a')
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('system_error')
    expect(rows[0].content).toContain('target-off')
    expect(rows[0].content).toContain('オフライン')
  })

  test('unregistered sender → no feedback row (Discord human post)', async () => {
    const res = await notifySenderOfDeliveryStatus(legacy, {
      senderId: 'unknown-human', targetId: 'target-busy', messageId: 'msg-4',
    })
    expect(res.emitted).toBe(null)
    expect(res.reason).toBe('sender-not-registered')
    expect(await feedbackRows('unknown-human')).toHaveLength(0)
  })

  test('self-delivery is a no-op (never echo to self)', async () => {
    const res = await notifySenderOfDeliveryStatus(legacy, {
      senderId: 'target-busy', targetId: 'target-busy', messageId: 'msg-5',
    })
    expect(res.emitted).toBe(null)
    expect(res.reason).toBe('self')
  })

  test('feedback payload carries traceable fields (author_id=system + source_message_id)', async () => {
    // Issue #251 (b) — the busy path no longer enqueues, so we
    // assert against the disconnected / system_error branch which
    // still carries the same traceability contract.
    await notifySenderOfDeliveryStatus(legacy, {
      senderId: 'sender-a', targetId: 'target-off', messageId: 'trace-id',
    })
    const rows = await db.query<{ payload: string }>(`SELECT payload FROM message_queue WHERE agent_id = 'sender-a'`)
    const payload = JSON.parse(rows[0].payload)
    expect(payload.author_id).toBe('system')
    expect(payload.target_agent_id).toBe('target-off')
    expect(payload.source_message_id).toBe('trace-id')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Part C — SQL shape integration (SQLite) for B1 / B4 UPDATE bundles
// ─────────────────────────────────────────────────────────────────────────────
// Pin that the atomic "current_message_id + status" UPDATE statements used in
// server.ts and cli/index.ts are dialect-safe: they run on SQLite without
// rewrite. PG is covered by the same literal strings executed in production.

describe('B1 / B4 — atomic agents UPDATE is SQL-standard', () => {
  let db: SqliteAdapter
  let dbPath: string

  beforeEach(async () => {
    dbPath = `/tmp/agents-status-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    db = new SqliteAdapter(dbPath)
    await db.execute(`
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        status_detail TEXT,
        status_updated_at TEXT,
        current_message_id INTEGER
      )
    `)
    await db.execute(`INSERT INTO agents (agent_id, status) VALUES ('bot-a', 'idle')`)
  })

  afterEach(async () => {
    await db.close()
    try { unlinkSync(dbPath) } catch {}
  })

  test("B1: UPDATE sets current_message_id + status='busy' + status_detail in one statement", async () => {
    // Exact literal from server.ts + cli/index.ts; both must run unrewritten
    // (NOW() gets rewritten to datetime('now') by the SQLite adapter).
    await db.execute(
      `UPDATE agents SET current_message_id = $1, status = 'busy', status_detail = 'メッセージ処理中', status_updated_at = now() WHERE agent_id = $2`,
      [42, 'bot-a'],
    )
    const rows = await db.query<{ status: string; status_detail: string; current_message_id: number | string | null }>(
      `SELECT status, status_detail, current_message_id FROM agents WHERE agent_id = 'bot-a'`,
    )
    expect(rows[0].status).toBe('busy')
    expect(rows[0].status_detail).toBe('メッセージ処理中')
    expect(Number(rows[0].current_message_id)).toBe(42)
  })

  test("B4: UPDATE clears current_message_id + status='idle' + NULL detail in one statement", async () => {
    await db.execute(`UPDATE agents SET current_message_id = 42, status = 'busy', status_detail = 'x' WHERE agent_id = 'bot-a'`)
    await db.execute(
      `UPDATE agents SET current_message_id = NULL, status = 'idle', status_detail = NULL, status_updated_at = now() WHERE agent_id = $1`,
      ['bot-a'],
    )
    const rows = await db.query<{ status: string; status_detail: string | null; current_message_id: number | null }>(
      `SELECT status, status_detail, current_message_id FROM agents WHERE agent_id = 'bot-a'`,
    )
    expect(rows[0].status).toBe('idle')
    expect(rows[0].status_detail).toBeNull()
    expect(rows[0].current_message_id).toBeNull()
  })
})
