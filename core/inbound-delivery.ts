/**
 * Atomic Step 7b + 7d persistence for inbound deliveries (Issue #177).
 *
 * ### Background
 *
 * `handleInboundMessage` previously ran Step 7b
 * (`UPDATE agent_messages SET metadata = metadata || jsonb_build_object('to', $1)`)
 * and Step 7d (`INSERT INTO message_queue ... ON CONFLICT DO NOTHING`) as two
 * independent queries. Step 7b's error was silently swallowed by
 * `.catch(() => {})`. When 7b failed (or raced), Step 7d still produced a
 * message_queue row, but `agent_messages.metadata->>'to'` stayed NULL.
 * `fetchNewMessages` (WHERE `metadata->>'to' = $agent`) filtered that row
 * out, so the inbox MCP tool reported empty — "inbox-ghost". Observed
 * 2026-04-15 07:09-07:21 JST with CEO's `<@lead-ama> テスト` post.
 *
 * ### Fix
 *
 * Run both queries in one `BEGIN`/`COMMIT` on a **transaction-private**
 * `pg.Client`. Partial state (one half written, the other not) is no longer
 * reachable; failure rolls both back and surfaces a logged error instead of
 * a silent drop.
 *
 * ### Transaction-private connection (Cycle 2 — auditor BLOCKER 1)
 *
 * `server.ts::getDb()` returns a process-global singleton `pg.Client`. If
 * two concurrent inbound handlers both called `persistInboundDelivery()`
 * with that singleton, their `BEGIN`/`COMMIT` pairs would interleave on one
 * socket — transaction semantics on a single `pg.Client` are NOT per-call;
 * they are connection-wide. Under concurrent invocation the "per-message
 * atomic boundary" would be a lie.
 *
 * The primary entry point is `persistInboundDelivery(databaseUrl, params)`.
 * It instantiates a fresh `pg.Client` from the URL, connects, runs the
 * transaction, and `end()`s in `finally`. Each call therefore owns its
 * connection for its lifetime; concurrent calls cannot interleave.
 *
 * The lower-level `persistInboundDeliveryOnClient(client, params)` is
 * exported for unit tests that want to verify the `BEGIN`/`UPDATE`/
 * `INSERT`/`COMMIT` sequencing against a mock client. Production code must
 * NOT call it with the shared singleton.
 *
 * ### UPDATE row match enforcement (Cycle 2 — auditor BLOCKER 2)
 *
 * Step 7b's `UPDATE` may match zero rows if `messageId` is stale (e.g.
 * caller passes an id that no longer exists in `agent_messages` because a
 * prior request path deleted it, or passed a typo). Ignoring `rowCount`
 * and proceeding to Step 7d re-introduces the inbox-ghost: queue row
 * created, `metadata.to` still NULL, `fetchNewMessages` filters the row
 * out. The helper therefore verifies `rowCount === 1` after the UPDATE and
 * forces `ROLLBACK` with `error: 'update_no_match'` otherwise. Step 7d
 * never runs in that branch.
 *
 * ### Retry idempotency
 *
 * Preserved by the existing unique partial index `uq_mq_agent_message`
 * (`agent_id`, `message_id`) WHERE `message_id IS NOT NULL`. A second
 * call with the same `message_id` is absorbed by `ON CONFLICT DO NOTHING`;
 * `duplicateDedup` reports this via `rowCount = 0` on the INSERT so the
 * caller can log the dedup at the inbound level.
 *
 * See SSOT `docs/agent-com-message-queue-spec.md` §7.3.1 for the invariant
 * set this helper pins.
 */
import { Client } from 'pg'

/**
 * Minimal client contract exposed for unit tests. `pg.Client` satisfies
 * this, and mocked clients in tests implement the same shape.
 *
 * **Production code must NOT call `persistInboundDeliveryOnClient` with a
 * shared connection** (e.g. the singleton returned by
 * `server.ts::getDb()`). Transaction semantics on a single `pg.Client` are
 * connection-wide, not per-call, so two concurrent callers sharing a
 * connection would interleave `BEGIN`/`COMMIT`. Use
 * `persistInboundDelivery(databaseUrl, …)` instead — it owns a dedicated
 * client for the call's lifetime.
 */
export interface InboundDeliveryClient {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>
}

export interface InboundDeliveryParams {
  receiverAgentId: string
  /** agent_messages.id (UUID) returned by deps.saveMessage. */
  messageId: string
  /**
   * Pre-serialized JSON payload for `message_queue.payload`, which is a
   * `text` column (see `db/migrate.ts` — column type is `TEXT NOT NULL`,
   * NOT `jsonb`). Callers build this string from the Discord event so the
   * helper does not need the full event shape — keeps the seam narrow for
   * tests.
   */
  mqPayloadJson: string
  /**
   * Issue #277 (B) — auto-skip. When set, the message_queue row is inserted
   * with `status='skipped'` and `failed_reason=skipReason` instead of the
   * default `status='pending'`. The 7b metadata.to UPDATE and dedup ON
   * CONFLICT semantics are unchanged so audit history still reaches the
   * caller; only `next` delivery is suppressed (callers should also skip
   * any push signal when this is set).
   */
  skipReason?: string
}

export interface InboundDeliveryResult {
  /** True iff COMMIT succeeded. False means a ROLLBACK was attempted. */
  committed: boolean
  /**
   * True when the message_queue INSERT was a no-op because
   * (agent_id, message_id) already existed (ON CONFLICT DO NOTHING).
   * Only meaningful when `committed === true`.
   */
  duplicateDedup: boolean
  /**
   * Populated on failure. Forms:
   *   - the thrown `Error` (pg driver error, connection loss, unexpected
   *     server state, or the `.connect()` failure in
   *     `persistInboundDelivery`). No sentinel wrapping — callers that
   *     need to discriminate should inspect the error object.
   *   - the string `'update_no_match'` when Step 7b's `UPDATE` matched
   *     zero rows (stale `messageId`). This is the one string sentinel
   *     used by the helper; everything else is the raw driver error.
   */
  error?: unknown
}

/**
 * Primary production entry point. Instantiates a dedicated `pg.Client` for
 * the call, runs the 7b+7d transaction, and ends the client in `finally`.
 * Concurrent calls do NOT share a connection, so their transactions cannot
 * interleave. See module docstring "Transaction-private connection".
 */
export async function persistInboundDelivery(
  databaseUrl: string,
  params: InboundDeliveryParams,
): Promise<InboundDeliveryResult> {
  let client: Client
  try {
    client = new Client({ connectionString: databaseUrl })
    await client.connect()
  } catch (err) {
    return { committed: false, duplicateDedup: false, error: err }
  }
  try {
    return await persistInboundDeliveryOnClient(client, params)
  } finally {
    // Teardown failure is non-fatal for the caller (the transaction has
    // already either committed or rolled back at this point), but we log
    // it to stderr so connection-churn / server-side cleanup issues
    // become observable instead of silently piling up.
    await client.end().catch((err) => {
      process.stderr.write(
        `agent-comms: persistInboundDelivery client.end() failed (non-fatal): ${err}\n`,
      )
    })
  }
}

/**
 * Lower-level entry point. Runs the 7b+7d transaction on the caller-owned
 * `client` and does NOT close it. Exported for tests that want to verify
 * the `BEGIN`/`UPDATE`/`INSERT`/`COMMIT` sequencing against a mock client
 * or a pre-existing `pg.Client` (e.g. the DB-integration test that seeds a
 * probe `agent_messages` row on the same client).
 *
 * **Not for production use** — see module docstring and
 * `InboundDeliveryClient` for why the production path must own its
 * connection.
 */
export async function persistInboundDeliveryOnClient(
  client: InboundDeliveryClient,
  params: InboundDeliveryParams,
): Promise<InboundDeliveryResult> {
  const { receiverAgentId, messageId, mqPayloadJson, skipReason } = params
  try {
    await client.query('BEGIN')
    // Explicit casts: node-postgres cannot always infer the parameter
    // types for `jsonb_build_object('to', $1)` (text) or the `$2::uuid`
    // `id` comparison, and pg raises PG 42P18 "could not determine data
    // type of parameter". Anchoring each parameter to its column type
    // side-steps the inference ambiguity.
    const upd = await client.query(
      `UPDATE agent_messages SET metadata = metadata || jsonb_build_object('to', $1::text) WHERE id = $2::uuid`,
      [receiverAgentId, messageId],
    )
    // BLOCKER 2 (Cycle 2): if the UPDATE matched zero rows — stale
    // messageId — the row's metadata.to stays NULL. Proceeding to Step 7d
    // would create a message_queue row whose agent_messages peer fails
    // the fetchNewMessages metadata.to filter ("inbox-ghost"). Roll back
    // unconditionally.
    if ((upd.rowCount ?? 0) !== 1) {
      await client.query('ROLLBACK').catch(() => {})
      return {
        committed: false,
        duplicateDedup: false,
        error: 'update_no_match',
      }
    }
    // message_queue.(agent_id, message_id, payload) are all `text`
    // columns (see `db/migrate.ts`); no uuid / jsonb cast.
    // Issue #277 (B) — when skipReason is set, INSERT directly into the
    // 'skipped' terminal state with failed_reason populated so `next` will
    // never claim the row. Audit / history stay intact.
    // v0.9: 'skipped' / failed_reason removed from schema. Skip-on-INSERT
    // collapsed to terminal close as 'replied' (= row exists for audit,
    // never claimed by `next`).
    const mqIns = skipReason
      ? await client.query(
          `INSERT INTO message_queue (agent_id, message_id, payload, status)
           VALUES ($1::text, $2::text, $3::text, 'replied')
           ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          [receiverAgentId, messageId, mqPayloadJson],
        )
      : await client.query(
          `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1::text, $2::text, $3::text)
           ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          [receiverAgentId, messageId, mqPayloadJson],
        )
    await client.query('COMMIT')
    return {
      committed: true,
      duplicateDedup: (mqIns.rowCount ?? 0) === 0,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    return { committed: false, duplicateDedup: false, error: err }
  }
}
