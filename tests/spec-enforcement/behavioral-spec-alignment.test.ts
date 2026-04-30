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
  test('send handler rejects with INVALID_REPLY_TO when reply_to has no in-flight claim', () => {
    // Issue #278 §1 error taxonomy: NO_CURRENT_MESSAGE is retired in favour
    // of INVALID_REPLY_TO once the per-row claim path lands. Both the
    // missing-reply_to client bug and the no-row-found case must surface
    // the same error class so callers do not have to special-case them.
    expect(SERVER_SRC).toMatch(/Error \[INVALID_REPLY_TO\]:\s*reply_to is required for send/)
    expect(SERVER_SRC).toMatch(/Error \[INVALID_REPLY_TO\]:\s*no in-flight claim for reply_to=/)
    // Legacy NO_CURRENT_MESSAGE branch must be gone from the MCP send path.
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", sendIdx)
    const handler = SERVER_SRC.slice(sendIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    expect(handler).not.toMatch(/Error \[NO_CURRENT_MESSAGE\]/)
  })
  test('guard locks the message_queue claim row with FOR UPDATE (per-row claim atomic)', () => {
    // Per-row claim replaces the agents single-slot lock. The handler must
    // SELECT ... FOR UPDATE the message_queue row keyed by reply_to +
    // claimed_by + status='read' so two concurrent send calls targeting
    // the same claim serialise on the row lock, while independent claims
    // proceed in parallel (Issue #278 §A multi in-flight).
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    expect(sendIdx).toBeGreaterThan(-1)
    const handler = SERVER_SRC.slice(sendIdx, sendIdx + 4500)
    expect(handler).toMatch(/spec §4\.2 step 1.*per-row claim guard/s)
    expect(handler).toMatch(/SELECT id FROM message_queue[\s\S]*WHERE message_id = \$1 AND claimed_by = \$2 AND status = 'read'[\s\S]*FOR UPDATE/)
    expect(handler).toMatch(/txClient\.query\(['"]BEGIN['"]\)/)
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
    const repliedIdx = SERVER_SRC.indexOf(
      `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1 WHERE id = $2`,
    )
    const outboundIdx = SERVER_SRC.indexOf(
      `INSERT INTO outbound_queue (message_id, agent_id, channel_external_id, content)`,
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

describe('Behavioral FAIL B1 — next flips agents.status to busy (Issue #278 segment 3d)', () => {
  test('server.ts next flips agents.status to busy without stamping current_message_id', () => {
    // The in-flight pointer lives on the message_queue claim row
    // (claimed_by + claim_expires_at) post-segment-3d; the agents
    // UPDATE only carries the status flip.
    expect(SERVER_SRC).toMatch(
      /UPDATE agents SET status = 'busy', status_detail = 'メッセージ処理中', status_updated_at = now\(\) WHERE agent_id = \$1/,
    )
  })
  test('cli nextMessage mirrors the same agents UPDATE shape', () => {
    expect(CLI_SRC).toMatch(
      /UPDATE agents SET status = 'busy', status_detail = 'メッセージ処理中', status_updated_at = now\(\) WHERE agent_id = \$1/,
    )
  })
})

describe('Behavioral FAIL B4 — send flips agents.status to idle (Issue #278 segment 3d)', () => {
  test('server.ts send flips agents.status to idle without touching current_message_id', () => {
    expect(SERVER_SRC).toMatch(
      /UPDATE agents SET status = 'idle', status_detail = NULL, status_updated_at = now\(\) WHERE agent_id = \$1/,
    )
    // Negative pin: a refactor that re-introduces the legacy column
    // write would trip this.
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const quoteIdx = SERVER_SRC.indexOf("if (name === 'quote')", sendIdx)
    const handler = SERVER_SRC.slice(sendIdx, quoteIdx === -1 ? SERVER_SRC.length : quoteIdx)
    expect(handler).not.toMatch(/UPDATE agents SET current_message_id = NULL/)
  })
  test('cli sendMessage mirrors the same agents UPDATE shape', () => {
    expect(CLI_SRC).toMatch(
      /UPDATE agents SET status = 'idle', status_detail = NULL, status_updated_at = now\(\) WHERE agent_id = \$1/,
    )
    expect(CLI_SRC).not.toMatch(/UPDATE agents SET current_message_id = NULL, status = 'idle'/)
  })
})

describe('Behavioral FAIL B3 — notify tool implemented', () => {
  test('MCP notify tool is listed with channel + mentions + content required', () => {
    expect(SERVER_SRC).toMatch(/name:\s*'notify'/)
    expect(SERVER_SRC).toMatch(/required:\s*\[['"]channel['"],\s*['"]mentions['"],\s*['"]content['"]\]/)
  })
  test('MCP notify handler exists and does NOT touch reply_to / current_message_id', () => {
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    expect(notifyIdx).toBeGreaterThan(-1)
    const handler = SERVER_SRC.slice(notifyIdx, notifyIdx + 8000)
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
