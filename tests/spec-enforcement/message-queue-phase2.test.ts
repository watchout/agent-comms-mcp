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
// FEAT-005: handleInboundMessage (T3) lives in adapters/inbound-
// receiver.ts. Concat so T3 structural pins still fire at the new home.
// Issue #177: the message_queue INSERT was extracted into
// core/inbound-delivery.ts (persistInboundDelivery) so 7b UPDATE + 7d INSERT
// can share a single BEGIN/COMMIT. Concat the new home so the same
// structural pins keep firing.
const SERVER_SRC =
  readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(REPO_ROOT, 'adapters', 'inbound-receiver.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(REPO_ROOT, 'core', 'inbound-delivery.ts'), 'utf-8')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')

// ─────────────────────────────────────────────────────────────────────────────
// T1: db/migrate.ts contains the message_queue + agents.current_message_id DDL
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: a future migration cleanup that drops the table or the
// column would silently break Phase 2. Pin the table DDL, the index DDL, the
// status CHECK constraint, and the agents column ALTER.
describe('T1 — db/migrate.ts ships the message_queue table + per-row claim columns', () => {
  test('CREATE TABLE message_queue is present', () => {
    expect(MIGRATE_SRC).toMatch(/CREATE TABLE IF NOT EXISTS message_queue/)
  })
  test('message_queue.id is BIGSERIAL PRIMARY KEY', () => {
    expect(MIGRATE_SRC).toMatch(/id\s+BIGSERIAL\s+PRIMARY KEY/)
  })
  test('message_queue.status CHECK constraint covers all five states (v2.1.0 adds failed)', () => {
    // v2.1.0 (PR #220): `failed` was added alongside the existing
    // pending/read/replied/skipped so that explicit abandon (fail CLI) can
    // persist a reason distinct from operator-issued skip.
    expect(MIGRATE_SRC).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'read'\s*,\s*'replied'\s*,\s*'skipped'\s*,\s*'failed'\s*\)\s*\)/)
  })
  test('idx_mq_agent_pending partial index is created', () => {
    expect(MIGRATE_SRC).toMatch(/CREATE INDEX IF NOT EXISTS idx_mq_agent_pending/)
    expect(MIGRATE_SRC).toMatch(/ON message_queue\(agent_id, status, priority DESC, created_at ASC\)\s*\n?\s*WHERE status = 'pending'/)
  })
  test('Issue #278 (A) per-row claim columns + the legacy current_message_id DROP', () => {
    // The single-slot agents.current_message_id is gone; the per-row
    // claim columns on message_queue (claimed_by / claimed_at /
    // claim_expires_at) are its structural replacement, joined by the
    // partial index that the TTL sweeper relies on.
    expect(MIGRATE_SRC).toMatch(/ADD COLUMN IF NOT EXISTS claimed_by TEXT/)
    expect(MIGRATE_SRC).toMatch(/ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ/)
    expect(MIGRATE_SRC).toMatch(/CREATE INDEX IF NOT EXISTS idx_mq_expired_claims/)
    // Issue #278 (A) segment 3d hotfix (2026-04-30 incident) — the
    // DROP COLUMN current_message_id is hosted ONLY in the paired G-2
    // migration file, not in the auto-applied bootstrap, to prevent
    // every fleet restart from re-firing the drop while old-code
    // bots are still reading the column. The bootstrap keeps the
    // column ADD so fresh DBs match the live fleet shape until a
    // coordinated cutover.
    const dropMigration = readFileSync(
      join(REPO_ROOT, 'db/migrations/2026-04-30-stage-b-drop-current-message-id.up.sql'),
      'utf-8',
    )
    expect(dropMigration).toMatch(/ALTER TABLE agents DROP COLUMN IF EXISTS current_message_id/)
    expect(MIGRATE_SRC).toMatch(/ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_message_id/)
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
    // Issue #177: the INSERT is now owned by persistInboundDelivery
    // (core/inbound-delivery.ts), which handleInboundMessage invokes with
    // receiverAgentId + messageId + mqPayload. Two pins:
    //   (a) handleInboundMessage calls persistInboundDelivery(client, {
    //       receiverAgentId, messageId, mqPayloadJson: mqPayload })
    //   (b) persistInboundDelivery contains the message_queue INSERT
    //       keyed by (agent_id, message_id, payload).
    const fnStart = SERVER_SRC.indexOf('async function handleInboundMessage')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = SERVER_SRC.indexOf('return { delivered: true', fnStart)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = SERVER_SRC.slice(fnStart, fnEnd)

    // (a) call site delegation — receiverAgentId + messageId + mqPayload
    //     are forwarded as named keys of the params object. Cycle 2
    //     (auditor BLOCKER 1): the first arg is `d.databaseUrl` so the
    //     helper owns a transaction-private pg.Client, not the shared
    //     singleton from tryGetDb().
    expect(body).toMatch(/persistInboundDelivery\s*\(\s*d\.databaseUrl\s*,\s*\{[\s\S]{0,300}?receiverAgentId\s*,[\s\S]{0,200}?messageId\s*,[\s\S]{0,200}?mqPayloadJson\s*:\s*mqPayload/)

    // (b) helper body holds the INSERT + ON CONFLICT DO NOTHING pin.
    //     SERVER_SRC is concatenated with core/inbound-delivery.ts above,
    //     so the same regex still matches at the new home.
    expect(SERVER_SRC).toMatch(/INSERT INTO message_queue\s*\(agent_id,\s*message_id,\s*payload\)/)
    expect(SERVER_SRC).toMatch(/ON\s+CONFLICT[\s\S]{0,200}?DO\s+NOTHING/i)
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
  test('Issue #278 segment 3c — legacy priorId / IMPLICIT_ABANDON read in `next` is gone', () => {
    const body = nextMessageBody()
    // The pre-Stage-B path read agents.current_message_id and synchronously
    // flipped any orphaned 'read' row to 'failed'/'IMPLICIT_ABANDON'. Both
    // are removed; orphan recovery is structural via the claim-TTL sweeper
    // (core/claim-ttl.ts).
    expect(body).not.toMatch(/SELECT current_message_id FROM agents/)
    expect(body).not.toMatch(/SET status\s*=\s*'failed',\s*failed_reason\s*=\s*'IMPLICIT_ABANDON'/)
    expect(body).not.toMatch(/SET status\s*=\s*'skipped'\s+WHERE id\s*=\s*\$1 AND status\s*=\s*'read'/)
  })
  test('SELECTs the oldest pending row with priority/created_at ordering', () => {
    const body = nextMessageBody()
    // PR#134 ARC follow-up: status condition first, then agent_id (matches
    // lead-ama's prescribed snippet) and FOR UPDATE SKIP LOCKED appended.
    expect(body).toMatch(/FROM message_queue\s*\n?\s*WHERE status = 'pending' AND agent_id = \$1\s*\n?\s*ORDER BY priority DESC, created_at ASC/)
  })
  test('marks read + stamps the per-row claim + flips status to busy', () => {
    const body = nextMessageBody()
    // Issue #278 segment 3d — the in-flight pointer lives on the
    // message_queue row (claimed_by + claimed_at + claim_expires_at),
    // not on agents.current_message_id. The agents UPDATE only flips
    // status='busy' now.
    expect(body).toMatch(/UPDATE message_queue\s*\n?\s*SET status\s*=\s*'read'[\s\S]*?claimed_by\s*=\s*\$1[\s\S]*?claimed_at\s*=\s*now\(\)[\s\S]*?claim_expires_at\s*=\s*\$2/)
    expect(body).toMatch(/UPDATE agents SET status\s*=\s*'busy',\s*status_detail\s*=\s*'メッセージ処理中'[\s\S]*?WHERE agent_id/)
    // Negative pin: the legacy single-slot stamp must not coexist.
    expect(body).not.toMatch(/UPDATE agents SET current_message_id\s*=\s*\$1/)
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
    // never pick the same row. Issue #278 §A: this is now the SOLE
    // serialisation point — the agents row lock has been retired.
    expect(body).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(body).not.toMatch(/SELECT current_message_id FROM agents WHERE agent_id\s*=\s*\$1\s*FOR UPDATE/)
  })
  // Issue #130 Phase 4: Mixed-Mode fallback test removed — signal path abolished.
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

describe('T5 — `agent-com send` resolves target via per-row claim (Issue #278 segment 3d)', () => {
  test('reads the most-recent active claim from message_queue, not agents.current_message_id', () => {
    const body = sendMessageBody()
    // Issue #278 segment 3d — the lookup is now keyed by claimed_by +
    // status='read' on message_queue, ordered by claimed_at DESC. The
    // legacy SELECT current_message_id from agents is gone.
    expect(body).toMatch(/SELECT id, message_id, payload FROM message_queue\s*\n?\s*WHERE claimed_by = \$1 AND status = 'read'/)
    expect(body).not.toMatch(/SELECT current_message_id FROM agents WHERE agent_id/)
  })
  test('INVALID_REPLY_TO error when no active claim resolves the target', () => {
    // Issue #278 §1 error taxonomy: NO_CURRENT_MESSAGE retired in favour
    // of INVALID_REPLY_TO. Same failure mode (no in-flight claim), same
    // user-facing remediation (run `agent-com next` first or wait for
    // sweeper).
    const body = sendMessageBody()
    expect(body).toMatch(/Error \[INVALID_REPLY_TO\]/)
    expect(body).not.toMatch(/Error \[NO_CURRENT_MESSAGE\]/)
  })
  test('on success, queue mode UPDATEs message_queue to replied + idles the agent', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/UPDATE message_queue SET status\s*=\s*'replied',\s*replied_at\s*=\s*now\(\),\s*replied_with/)
    // Issue #278 segment 3d — agents.current_message_id is gone, so the
    // idle-flip UPDATE no longer touches that column. Negative pin
    // catches a refactor that brings the column write back.
    expect(body).toMatch(/UPDATE agents SET status\s*=\s*'idle'/)
    expect(body).not.toMatch(/UPDATE agents SET current_message_id\s*=\s*NULL/)
  })
  test('sendMessage wraps the body in BEGIN/COMMIT with FOR UPDATE on the claim row', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/db\.query\(['"]BEGIN['"]\)/)
    expect(body).toMatch(/db\.query\(['"]COMMIT['"]\)/)
    expect(body).toMatch(/db\.query\(['"]ROLLBACK['"]\)/)
    // Issue #278 segment 3d — the FOR UPDATE lock is now on the
    // message_queue claim row, not the agents row. Independent claims
    // proceed in parallel (multi in-flight); concurrent sends targeting
    // the same claim serialise here.
    expect(body).toMatch(/FOR UPDATE/)
    // Early exits inside the transaction throw CliSendExit instead of calling
    // process.exit (which would bypass the ROLLBACK / db.end() finally chain).
    expect(body).toMatch(/class CliSendExit extends Error/)
    expect(body).toMatch(/throw new CliSendExit\(1\)/)
  })
})
