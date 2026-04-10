#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #128 Phase 2 — message_queue + queue-based
 * next/send (message-queue-spec §3.2 / §4.1 / §4.2).
 *
 * Background:
 *   Phase 1 shipped a provisional CLI built on filesystem inbox signals
 *   (PR#133). Phase 2 introduces the spec-mandated `message_queue` table and
 *   the `agents.current_message_id` column so:
 *
 *     - the receiver writes one queue row per pushTarget on send AND inbound
 *     - `agent-com next` pops the oldest pending row, marks it `read`, and
 *       stamps agents.current_message_id (implicit-skipping any prior row)
 *     - `agent-com send` reads agents.current_message_id, INSERTs the reply,
 *       and marks the queue row `replied`
 *
 *   Mixed Mode (spec §21): the legacy filesystem-signal path remains as a
 *   fallback during the cutover so existing bots that haven't migrated still
 *   work. Operators can disable the fallback with AGENT_COMMS_LEGACY_QUEUE=0.
 *
 * These tests are source-level (no live DB). A regression that drops any of
 * the queue invariants — table DDL, receiver INSERTs, next/send queue logic,
 * Mixed-Mode fallback — will fail loudly here.
 *
 * See:
 *   - db/migrate.ts                                 (table DDL)
 *   - server.ts send-tool pushTargets loop          (~L2079)
 *   - server.ts handleInboundMessage Step 7d        (~L1376)
 *   - cli/index.ts nextMessage / sendMessage        (Phase 2 refactor)
 *   - docs/agent-com-message-queue-spec.md §3.2/§4.1/§4.2
 *   - github.com/watchout/agent-comms-mcp/issues/128
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const MIGRATE_SRC = readFileSync(join(REPO_ROOT, 'db', 'migrate.ts'), 'utf-8')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')

// ─────────────────────────────────────────────────────────────────────────────
// T1: db/migrate.ts contains the message_queue + agents.current_message_id DDL
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: a future migration cleanup that drops the table or the
// column would silently break Phase 2. Pin the table DDL, the index DDL, the
// status CHECK constraint, and the agents column ALTER.
describe('T1 — db/migrate.ts ships the message_queue table + agents.current_message_id', () => {
  test('CREATE TABLE message_queue is present', () => {
    expect(MIGRATE_SRC).toMatch(/CREATE TABLE IF NOT EXISTS message_queue/)
  })
  test('message_queue.id is BIGSERIAL PRIMARY KEY', () => {
    expect(MIGRATE_SRC).toMatch(/id\s+BIGSERIAL\s+PRIMARY KEY/)
  })
  test('message_queue.status CHECK constraint covers all four states', () => {
    expect(MIGRATE_SRC).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'read'\s*,\s*'replied'\s*,\s*'skipped'\s*\)\s*\)/)
  })
  test('idx_mq_agent_pending partial index is created', () => {
    expect(MIGRATE_SRC).toMatch(/CREATE INDEX IF NOT EXISTS idx_mq_agent_pending/)
    expect(MIGRATE_SRC).toMatch(/ON message_queue\(agent_id, status, priority DESC, created_at ASC\)\s*\n?\s*WHERE status = 'pending'/)
  })
  test('agents.current_message_id BIGINT column is added', () => {
    expect(MIGRATE_SRC).toMatch(/ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_message_id BIGINT/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: server.ts send-tool pushTargets loop INSERTs into message_queue
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: a refactor that drops the queue INSERT from the send tool
// would mean recipients running Phase 2 `next` see no traffic from bot→bot
// sends. Pin both the per-part payload builder and the per-recipient INSERT.
describe('T2 — server.ts send-tool writes message_queue rows for each pushTarget', () => {
  test('per-part mqPayload literal is built before the recipient loop', () => {
    expect(SERVER_SRC).toMatch(/const mqPayload\s*=\s*JSON\.stringify\(\{[\s\S]{0,400}channel_id:\s*dest\.channelId/)
    // Required canonical fields the recipient's `next` will surface.
    expect(SERVER_SRC).toMatch(/mqPayload[\s\S]{0,400}thread_id:\s*dest\.threadId/)
    expect(SERVER_SRC).toMatch(/mqPayload[\s\S]{0,400}author_id:\s*agentId/)
    expect(SERVER_SRC).toMatch(/mqPayload[\s\S]{0,400}content:\s*partContent/)
  })
  test('the recipient loop INSERTs into message_queue with (agent_id, message_id, payload)', () => {
    // Anchor on the loop body (already verified in send-push-path.test.ts).
    const header = 'for (const recipient of delivery.pushTargets) {'
    const start = SERVER_SRC.indexOf(header)
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    let i = start + header.length - 1
    for (; i < SERVER_SRC.length; i++) {
      if (SERVER_SRC[i] === '{') depth++
      else if (SERVER_SRC[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const body = SERVER_SRC.slice(start, i + 1)
    expect(body).toMatch(/INSERT INTO message_queue\s*\(agent_id,\s*message_id,\s*payload\)/)
    expect(body).toMatch(/\[recipient,\s*id,\s*mqPayload\]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: handleInboundMessage INSERTs into message_queue for the receiver
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: symmetric with T2 — the inbound path must also populate
// the queue or Phase 2 `next` returns empty for inbound Discord messages.
describe('T3 — handleInboundMessage writes a message_queue row for the receiver', () => {
  test('inbound INSERT references receiverAgentId and the saved messageId', () => {
    // Locate handleInboundMessage and grab a window from there until the
    // closing `return { delivered: true ... }` so the assertions don't pick
    // up the unrelated send-tool INSERT.
    const fnStart = SERVER_SRC.indexOf('async function handleInboundMessage')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = SERVER_SRC.indexOf('return { delivered: true', fnStart)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = SERVER_SRC.slice(fnStart, fnEnd)
    expect(body).toMatch(/INSERT INTO message_queue\s*\(agent_id,\s*message_id,\s*payload\)/)
    expect(body).toMatch(/\[receiverAgentId,\s*messageId,\s*mqPayload\]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: cli `next` is queue-based and implements the §4.1 step list
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the previous filesystem-signal-only flow is now a fallback
// (Mixed Mode §21). Pin the queue path: implicit-skip prior current, SELECT
// pending, UPDATE read, UPDATE current_message_id, fallback gated on env var.
function nextMessageBody(): string {
  const fnStart = CLI_SRC.indexOf('async function nextMessage')
  const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
  return CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
}

describe('T4 — `agent-com next` reads from message_queue (Phase 2)', () => {
  test('reads agents.current_message_id and implicit-skips the prior row', () => {
    const body = nextMessageBody()
    expect(body).toMatch(/SELECT current_message_id FROM agents WHERE agent_id/)
    // Implicit-skip: UPDATE the prior row to 'skipped' if it's still 'read'.
    expect(body).toMatch(/UPDATE message_queue SET status\s*=\s*'skipped'[\s\S]*?status\s*=\s*'read'/)
  })
  test('SELECTs the oldest pending row with priority/created_at ordering', () => {
    const body = nextMessageBody()
    // PR#134 ARC follow-up: status condition first, then agent_id (matches
    // lead-ama's prescribed snippet) and FOR UPDATE SKIP LOCKED appended.
    expect(body).toMatch(/FROM message_queue\s*\n?\s*WHERE status = 'pending' AND agent_id = \$1\s*\n?\s*ORDER BY priority DESC, created_at ASC/)
  })
  test('marks read + stamps current_message_id atomically (per row)', () => {
    const body = nextMessageBody()
    expect(body).toMatch(/UPDATE message_queue SET status\s*=\s*'read',\s*read_at\s*=\s*now\(\)/)
    expect(body).toMatch(/UPDATE agents SET current_message_id\s*=\s*\$1\s*WHERE agent_id/)
  })
  // PR#134 ARC follow-up (lead-ama msg 1492279341898272849) — concurrency.
  test('SELECT + UPDATEs are wrapped in BEGIN/COMMIT with FOR UPDATE SKIP LOCKED', () => {
    const body = nextMessageBody()
    // Transaction wrapping
    expect(body).toMatch(/db\.query\(['"]BEGIN['"]\)/)
    expect(body).toMatch(/db\.query\(['"]COMMIT['"]\)/)
    // ROLLBACK on error so a partial state never leaks
    expect(body).toMatch(/db\.query\(['"]ROLLBACK['"]\)/)
    // FOR UPDATE SKIP LOCKED on the pending-row pop so concurrent next() calls
    // never pick the same row.
    expect(body).toMatch(/FOR UPDATE SKIP LOCKED/)
    // The agents row read also takes a row lock so the implicit-skip and the
    // current_message_id stamp can't race with another session.
    expect(body).toMatch(/SELECT current_message_id FROM agents WHERE agent_id\s*=\s*\$1\s*FOR UPDATE/)
  })
  test('Mixed-Mode legacy fallback is gated on AGENT_COMMS_LEGACY_QUEUE != 0', () => {
    const body = nextMessageBody()
    expect(body).toMatch(/AGENT_COMMS_LEGACY_QUEUE\s*!==\s*'0'/)
    expect(body).toMatch(/nextMessageFromSignal\(/)
  })
  test('output payload includes the §4.1 fields (waiting, mode, queue_id)', () => {
    const body = nextMessageBody()
    expect(body).toMatch(/waiting:/)
    expect(body).toMatch(/mode:\s*'queue'/)
    expect(body).toMatch(/queue_id:/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5: cli `send` resolves the in-flight target via agents.current_message_id
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the previous flow read /tmp state files only. Phase 2
// must prefer agents.current_message_id (queue mode) and only fall back to
// the legacy state file when the queue path returns nothing. Pin the
// resolution order, the message_queue UPDATE on success, and the
// current_message_id clear.
function sendMessageBody(): string {
  const fnStart = CLI_SRC.indexOf('async function sendMessage')
  const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
  return CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
}

describe('T5 — `agent-com send` resolves target via agents.current_message_id (Phase 2)', () => {
  test('reads current_message_id from agents before any state-file fallback', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/SELECT current_message_id FROM agents WHERE agent_id/)
    // Hydrate from message_queue.payload after we have a non-null id.
    expect(body).toMatch(/SELECT id, message_id, payload FROM message_queue WHERE id/)
  })
  test('falls back to legacy /tmp state file only when queue resolution misses', () => {
    const body = sendMessageBody()
    // The legacy branch runs only when target is still null after the queue lookup.
    expect(body).toMatch(/target === null && existsSync\(statePath\)/)
  })
  test('NO_CURRENT_MESSAGE error when neither path resolves a target', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/NO_CURRENT_MESSAGE/)
  })
  test('on success, queue mode UPDATEs message_queue to replied + clears current_message_id', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/UPDATE message_queue SET status\s*=\s*'replied',\s*replied_at\s*=\s*now\(\),\s*replied_with/)
    expect(body).toMatch(/UPDATE agents SET current_message_id\s*=\s*NULL/)
  })
  test('signal-mode success path still unlinks the legacy state + signal files', () => {
    const body = sendMessageBody()
    // The legacy branch is gated on target.mode !== 'queue' / target.state_path / target.signal_path.
    expect(body).toMatch(/target\.state_path/)
    expect(body).toMatch(/unlinkSync\(target\.signal_path\)/)
  })
  test('failure response carries mode so callers can branch on queue vs signal', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/ok:\s*false[\s\S]{0,200}mode:\s*target\.mode/)
  })
  // PR#134 ARC follow-up (lead-ama msg 1492279341898272849) — double-reply
  // prevention. In queue mode, even on Discord delivery failure the queue row
  // MUST be marked 'replied' and current_message_id MUST be cleared, so a
  // second `next/send` cycle can't generate a duplicate reply through the
  // spec'd flow. Outbound retry is delegated to Phase 3 outbound_queue.
  test('queue-mode failure branch marks message_queue replied + clears current_message_id', () => {
    const body = sendMessageBody()
    // PR#134 transaction wrapper: slice from the guard to the
    // `throw new CliSendExit(1)` that ends the failure branch.
    const guardIdx = body.indexOf('if (!deliveryResult.delivered)')
    expect(guardIdx).toBeGreaterThan(-1)
    const exitIdx = body.indexOf('throw new CliSendExit(1)', guardIdx)
    expect(exitIdx).toBeGreaterThan(guardIdx)
    const failureBranch = body.slice(guardIdx, exitIdx)
    // The replied UPDATE is gated on queue mode (target.mode === 'queue').
    expect(failureBranch).toMatch(/target\.mode\s*===\s*'queue'/)
    expect(failureBranch).toMatch(/UPDATE message_queue SET status\s*=\s*'replied'/)
    expect(failureBranch).toMatch(/UPDATE agents SET current_message_id\s*=\s*NULL/)
  })
  test('signal-mode failure branch does NOT touch the legacy filesystem state', () => {
    const body = sendMessageBody()
    const guardIdx = body.indexOf('if (!deliveryResult.delivered)')
    const exitIdx = body.indexOf('throw new CliSendExit(1)', guardIdx)
    const failureBranch = body.slice(guardIdx, exitIdx)
    // The Phase 1.5 invariant is preserved: signal mode leaves both files in
    // place so a re-run can retry. The failure branch must NOT contain any
    // unlinkSync calls.
    expect(failureBranch).not.toMatch(/unlinkSync/)
  })
  // PR#134 ARC follow-up (lead-ama msg 1492283029933133874) — concurrent send
  // race prevention. The entire body must run inside BEGIN/COMMIT with
  // FOR UPDATE on the agents row, so two parallel `agent-com send` calls
  // serialise on the lock and the second sees current_message_id = NULL.
  test('sendMessage wraps the body in BEGIN/COMMIT with FOR UPDATE on agents', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/db\.query\(['"]BEGIN['"]\)/)
    expect(body).toMatch(/db\.query\(['"]COMMIT['"]\)/)
    expect(body).toMatch(/db\.query\(['"]ROLLBACK['"]\)/)
    // The agents row read takes the row lock so concurrent sends serialise.
    expect(body).toMatch(/SELECT current_message_id FROM agents WHERE agent_id\s*=\s*\$1\s*FOR UPDATE/)
    // Early exits inside the transaction throw CliSendExit instead of calling
    // process.exit (which would bypass the ROLLBACK / db.end() finally chain).
    expect(body).toMatch(/class CliSendExit extends Error/)
    expect(body).toMatch(/throw new CliSendExit\(1\)/)
  })
})
