#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #129 Phase 3 — outbound_queue + receiver
 * consumer (message-queue-spec §3.3 / §7).
 *
 * Background:
 *   Phase 1.5 (PR#133) and Phase 2 (PR#134) had the send tool / CLI call
 *   Discord directly: server.ts:sendAdapterMessage and cli/index.ts's local
 *   `deliverToDiscord` REST helper. Both held their transactions / agents
 *   row lock during the (potentially slow) HTTP call.
 *
 *   Phase 3 introduces the spec-mandated `outbound_queue` table and a
 *   server-side consumer that polls it on a 1-second tick. The send tool
 *   and CLI now INSERT into outbound_queue and return immediately; the
 *   consumer dequeues and posts. Lock holding time drops from
 *   ~Discord-RTT to ~1ms (DB only) and outbound retries are centralised.
 *
 * These tests are source-level (no live DB / no live HTTP). A regression
 * that drops the table DDL, the consumer, the send-tool refactor, or the
 * CLI refactor will fail loudly here.
 *
 * See:
 *   - db/migrate.ts                                           (table DDL)
 *   - server.ts startOutboundConsumer / consumeOneOutboundRow (consumer)
 *   - server.ts send-tool delivery loop                       (queue INSERT)
 *   - cli/index.ts sendMessage                                (queue INSERT)
 *   - docs/agent-com-message-queue-spec.md §3.3 / §7
 *   - github.com/watchout/agent-comms-mcp/issues/129
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const MIGRATE_SRC = readFileSync(join(REPO_ROOT, 'db', 'migrate.ts'), 'utf-8')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')

// ─────────────────────────────────────────────────────────────────────────────
// T1: db/migrate.ts ships the outbound_queue DDL + index
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: a future migration cleanup that drops the table or the
// partial pending index would silently break Phase 3. Pin every column the
// spec lists, the status CHECK, and the index.
describe('T1 — db/migrate.ts ships the outbound_queue table', () => {
  test('CREATE TABLE outbound_queue is present', () => {
    expect(MIGRATE_SRC).toMatch(/CREATE TABLE IF NOT EXISTS outbound_queue/)
  })
  test('outbound_queue.id is BIGSERIAL PRIMARY KEY', () => {
    expect(MIGRATE_SRC).toMatch(/id\s+BIGSERIAL\s+PRIMARY KEY/)
  })
  test('all spec §3.3 columns are present', () => {
    // Slice from the CREATE TABLE to the trailing `);` so we don't accidentally
    // match columns from the message_queue table above it.
    const start = MIGRATE_SRC.indexOf('CREATE TABLE IF NOT EXISTS outbound_queue')
    expect(start).toBeGreaterThan(-1)
    const end = MIGRATE_SRC.indexOf(');', start)
    expect(end).toBeGreaterThan(start)
    const ddl = MIGRATE_SRC.slice(start, end)
    expect(ddl).toMatch(/message_id\s+TEXT\s+NOT NULL/)
    expect(ddl).toMatch(/agent_id\s+TEXT\s+NOT NULL/)
    expect(ddl).toMatch(/channel_external_id\s+TEXT\s+NOT NULL/)
    expect(ddl).toMatch(/content\s+TEXT\s+NOT NULL/)
    expect(ddl).toMatch(/mentions_display\s+TEXT/)
    expect(ddl).toMatch(/attachments\s+TEXT/)
    expect(ddl).toMatch(/reply_to_discord_id\s+TEXT/)
    expect(ddl).toMatch(/attempts\s+INTEGER\s+NOT NULL\s+DEFAULT 0/)
    expect(ddl).toMatch(/max_attempts\s+INTEGER\s+NOT NULL\s+DEFAULT 5/)
    expect(ddl).toMatch(/last_error\s+TEXT/)
    expect(ddl).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT now\(\)/)
    expect(ddl).toMatch(/sent_at\s+TIMESTAMPTZ/)
  })
  test('status CHECK constraint covers pending/processing/sent/failed', () => {
    // S2-A (FEAT-005): 'processing' added to allow atomic claim flip.
    expect(MIGRATE_SRC).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'processing'\s*,\s*'sent'\s*,\s*'failed'\s*\)\s*\)/)
  })
  test('idx_oq_pending partial index is created', () => {
    expect(MIGRATE_SRC).toMatch(/CREATE INDEX IF NOT EXISTS idx_oq_pending/)
    expect(MIGRATE_SRC).toMatch(/ON outbound_queue\(status, created_at ASC\)\s*\n?\s*WHERE status = 'pending'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: server.ts ships the outbound_queue consumer (§7)
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the consumer is the only thing that drains the queue,
// so a refactor that loses startOutboundConsumer / consumeOneOutboundRow
// would silently leave every send pending forever. Pin all the moving parts:
// the 1s polling interval, FOR UPDATE SKIP LOCKED row claim, attempts/
// max_attempts retry logic, sent/failed status transitions, and the
// registerAgent → startOutboundConsumer / unregisterAgent → stopOutboundConsumer
// lifecycle wiring.
describe('T2 — server.ts has an outbound_queue consumer', () => {
  test('startOutboundConsumer / stopOutboundConsumer / consumeOneOutboundRow are defined', () => {
    expect(SERVER_SRC).toMatch(/function startOutboundConsumer\s*\(/)
    expect(SERVER_SRC).toMatch(/function stopOutboundConsumer\s*\(/)
    expect(SERVER_SRC).toMatch(/async function consumeOneOutboundRow\s*\(/)
  })
  test('OUTBOUND_POLL_INTERVAL_MS is 1000 (spec: 1-second tick)', () => {
    expect(SERVER_SRC).toMatch(/OUTBOUND_POLL_INTERVAL_MS\s*=\s*1000/)
  })
  test('consumer claims rows with FOR UPDATE SKIP LOCKED inside an UPDATE … RETURNING', () => {
    // S2-A (FEAT-005): atomic claim flips status → 'processing' + sets claimed_at
    // + bumps attempts in a single UPDATE, and filters WHERE agent_id so each
    // bot only consumes its own rows. See s2a-daemon-owns-outbound.test.ts for
    // the atomic-claim invariants.
    expect(SERVER_SRC).toMatch(/UPDATE\s+outbound_queue[\s\S]*?SET[\s\S]*?attempts\s*=\s*attempts\s*\+\s*1/)
    expect(SERVER_SRC).toMatch(/SELECT id FROM outbound_queue[\s\S]*?WHERE status\s*=\s*'pending'/)
    expect(SERVER_SRC).toMatch(/FOR UPDATE SKIP LOCKED/)
    // RETURNING shape shifted: agent_id is now implicit (AGENT_ID filter on the
    // claim), so it no longer has to round-trip through the query result.
    expect(SERVER_SRC).toMatch(/RETURNING\s+id,\s*message_id,\s*channel_external_id/)
  })
  test('consumer transitions claimed rows to sent or failed', () => {
    expect(SERVER_SRC).toMatch(/UPDATE outbound_queue SET status\s*=\s*'sent',\s*sent_at\s*=\s*now\(\)/)
    expect(SERVER_SRC).toMatch(/UPDATE outbound_queue SET status\s*=\s*'failed',\s*last_error/)
    // Retry budget gate: only flip to 'failed' once attempts >= max_attempts.
    expect(SERVER_SRC).toMatch(/row\.attempts\s*>=\s*row\.max_attempts/)
  })
  test('consumer is wired into registerAgent / unregisterAgent', () => {
    // Started alongside the heartbeat in registerAgent.
    const regStart = SERVER_SRC.indexOf('async function registerAgent')
    const regEnd = SERVER_SRC.indexOf('\nasync function ', regStart + 1)
    const regBody = SERVER_SRC.slice(regStart, regEnd === -1 ? undefined : regEnd)
    expect(regBody).toMatch(/startOutboundConsumer\(\)/)
    // Stopped alongside the heartbeat in unregisterAgent.
    const unregStart = SERVER_SRC.indexOf('async function unregisterAgent')
    const unregEnd = SERVER_SRC.indexOf('\nasync function ', unregStart + 1)
    const unregBody = SERVER_SRC.slice(unregStart, unregEnd === -1 ? undefined : unregEnd)
    expect(unregBody).toMatch(/stopOutboundConsumer\(\)/)
  })
  test('consumer can be disabled via OUTBOUND_QUEUE_CONSUMER=0', () => {
    expect(SERVER_SRC).toMatch(/OUTBOUND_QUEUE_CONSUMER\s*===\s*'0'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: server.ts send-tool INSERTs into outbound_queue instead of calling
//     getDiscordClient(...).sendAdapterMessage directly
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the previous direct sendAdapterMessage call held the
// send-tool's per-recipient loop while Discord HTTP completed. Phase 3
// must INSERT into outbound_queue and let the consumer post asynchronously.
// Pin the new INSERT and assert the legacy call site is gone from the
// send-tool path.
describe('T3 — server.ts send-tool delivery uses outbound_queue', () => {
  test('send-tool INSERTs into outbound_queue with the right column tuple', () => {
    // Anchor on the send-tool send loop. We can't extract the loop body
    // perfectly without parsing TS, so check that the send handler contains
    // a `(message_id, agent_id, channel_external_id, content)` INSERT.
    expect(SERVER_SRC).toMatch(/INSERT INTO outbound_queue\s*\(message_id,\s*agent_id,\s*channel_external_id,\s*content\)/)
  })
  test('send-tool resolves channel_external_id via thread_adapters then channel_adapters', () => {
    // Both lookups must be present so threads land in the right place.
    expect(SERVER_SRC).toMatch(/SELECT external_id FROM thread_adapters WHERE thread_id\s*=\s*\$1\s+AND platform\s*=\s*'discord'/)
    expect(SERVER_SRC).toMatch(/SELECT external_id FROM channel_adapters WHERE channel_id\s*=\s*\$1\s+AND platform\s*=\s*'discord'/)
  })
  test('send-tool no longer calls sendAdapterMessage directly inside the part loop', () => {
    // The legacy call site was: getDiscordClient(agentId).sendAdapterMessage(...).
    // The consumer (consumeOneOutboundRow) still uses sendAdapterMessage to
    // do the actual post, so the symbol still appears in server.ts — we
    // pin its absence ONLY inside the send-tool handler body.
    const sendStart = SERVER_SRC.indexOf("if (name === 'send')")
    expect(sendStart).toBeGreaterThan(-1)
    // The send-tool body is large; bound the slice at the next tool handler
    // (the "if (name === 'unfocus')" / "if (name === 'quote')" / next 'if (name ===').
    const nextTool = SERVER_SRC.indexOf("if (name === '", sendStart + 1)
    const sendBody = SERVER_SRC.slice(sendStart, nextTool === -1 ? undefined : nextTool)
    expect(sendBody).not.toMatch(/getDiscordClient\([^)]*\)\.sendAdapterMessage/)
  })
  // PR#135 ARC follow-up (lead-ama msg 1492293367835660500): outbound_queue
  // INSERT failure must surface as an OUTBOUND_ENQUEUE_FAILED error so the
  // caller knows the Discord reply is permanently lost (the consumer never
  // sees the row). The CLI rolls back its transaction on the same failure;
  // the send tool must mirror that durability contract.
  test('send-tool surfaces OUTBOUND_ENQUEUE_FAILED on outbound_queue INSERT failure', () => {
    const sendStart = SERVER_SRC.indexOf("if (name === 'send')")
    expect(sendStart).toBeGreaterThan(-1)
    const nextTool = SERVER_SRC.indexOf("if (name === '", sendStart + 1)
    const sendBody = SERVER_SRC.slice(sendStart, nextTool === -1 ? undefined : nextTool)
    // The catch must NOT silently swallow the error.
    expect(sendBody).not.toMatch(/outbound_queue INSERT failed \(non-fatal\)/)
    // Positive: error code, audit log call, and isError result are all present.
    expect(sendBody).toMatch(/OUTBOUND_ENQUEUE_FAILED/)
    expect(sendBody).toMatch(/writeAuditLog\(\s*['"]outbound\.enqueue_failed['"]/)
    expect(sendBody).toMatch(/isError:\s*true/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: cli/index.ts sendMessage INSERTs into outbound_queue
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: Phase 1.5 / 2 had a local `deliverToDiscord` REST helper
// that ran inside the transaction. Phase 3 must replace it with an
// outbound_queue INSERT (still inside the transaction so the row commits
// atomically with the agent_messages INSERT and the message_queue UPDATE,
// but the actual HTTP is now async via the receiver consumer).
function sendMessageBody(): string {
  const fnStart = CLI_SRC.indexOf('async function sendMessage')
  const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
  return CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
}

describe('T4 — cli/index.ts sendMessage uses outbound_queue', () => {
  test('sendMessage INSERTs into outbound_queue', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/INSERT INTO outbound_queue\s*\(message_id,\s*agent_id,\s*channel_external_id,\s*content\)/)
  })
  test('sendMessage resolves channel_external_id via thread_adapters then channel_adapters', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/SELECT external_id FROM thread_adapters/)
    expect(body).toMatch(/SELECT external_id FROM channel_adapters/)
  })
  test('legacy deliverToDiscord helper is removed', () => {
    expect(CLI_SRC).not.toMatch(/async function deliverToDiscord\s*\(/)
  })
  test('sendMessage no longer awaits deliverToDiscord', () => {
    const body = sendMessageBody()
    expect(body).not.toMatch(/deliverToDiscord\(/)
    // Also: no direct fetch to discord.com from inside sendMessage
    expect(body).not.toMatch(/discord\.com\/api\//)
  })
  test('success response carries outbound_queued (not discord_delivered)', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/outbound_queued:\s*outboundQueued/)
    // The Phase 1.5 / 2 field is gone from the success response.
    // (the failure branch from PR#134 is also gone — Phase 3 has no
    // synchronous Discord-failure case.)
    expect(body).not.toMatch(/discord_delivered:\s*true/)
  })
  test('outbound_queued is false (with skip reason) when no Discord adapter exists', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/outboundSkipReason\s*=\s*'no discord adapter mapping/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5 — Phase C Step 1 PR-A (B): outbound consumer idempotency
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: duplicate Discord post caused by HTTP-response-loss
// retries (same outbound row claimed twice, same content posted twice). The
// fix pairs (a) a persisted discord_message_id with a short-circuit in the
// consumer and (b) a Discord enforceNonce nonce that lets the server dedupe
// within its ~5-minute window. If any link in that chain regresses we get
// duplicate posts again.
describe('T5 — outbound idempotency (PR-A B)', () => {
  test('migrate.ts adds discord_message_id column on outbound_queue', () => {
    expect(MIGRATE_SRC).toMatch(
      /ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS discord_message_id TEXT/,
    )
  })

  test('consumeOneOutboundRow selects discord_message_id in RETURNING', () => {
    const fnIdx = SERVER_SRC.indexOf('async function consumeOneOutboundRow')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 4000)
    expect(fnBody).toMatch(/RETURNING[^;]*discord_message_id/)
  })

  test('consumer short-circuits to sent when row already has discord_message_id', () => {
    const fnIdx = SERVER_SRC.indexOf('async function consumeOneOutboundRow')
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 6000)
    // Guard: the discord_message_id-presence check exists and routes to
    // status='sent' without re-calling sendAdapterMessage.
    expect(fnBody).toMatch(/if\s*\(\s*row\.discord_message_id\s*\)/)
    expect(fnBody).toMatch(/SET status = 'sent'[^`]*WHERE id = \$1/)
  })

  test('consumer passes nonce "out-<row.id>" to sendAdapterMessage', () => {
    const fnIdx = SERVER_SRC.indexOf('async function consumeOneOutboundRow')
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 6000)
    expect(fnBody).toMatch(/sendAdapterMessage\(\{[\s\S]*?nonce:\s*`out-\$\{row\.id\}`/)
  })

  test('consumer persists discord_message_id on mark-sent', () => {
    const fnIdx = SERVER_SRC.indexOf('async function consumeOneOutboundRow')
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 6000)
    expect(fnBody).toMatch(
      /UPDATE outbound_queue SET status = 'sent'[^`]*discord_message_id\s*=\s*\$1/,
    )
  })

  test('discord adapter sendMessage passes enforceNonce to Discord when nonce is provided', () => {
    const adapterSrc = readFileSync(join(REPO_ROOT, 'adapters', 'discord.ts'), 'utf-8')
    expect(adapterSrc).toMatch(/enforceNonce:\s*true/)
    expect(adapterSrc).toMatch(/nonce:\s*options\.nonce/)
  })

  test('SendOptions interface declares nonce', () => {
    const typesSrc = readFileSync(join(REPO_ROOT, 'adapters', 'types.ts'), 'utf-8')
    expect(typesSrc).toMatch(/nonce\?:\s*string/)
  })
})
