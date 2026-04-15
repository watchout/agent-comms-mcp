/**
 * Atomic Step 7b + 7d persistence for inbound deliveries (Issue #177).
 *
 * Before this helper, `handleInboundMessage` ran Step 7b
 * (`UPDATE agent_messages SET metadata = metadata || jsonb_build_object('to', $1)`)
 * and Step 7d (`INSERT INTO message_queue ... ON CONFLICT DO NOTHING`) as two
 * independent queries. Step 7b's error was silently swallowed by
 * `.catch(() => {})`. When 7b failed (or raced), Step 7d still produced a
 * message_queue row, but `agent_messages.metadata->>'to'` stayed NULL.
 * `fetchNewMessages` (WHERE `metadata->>'to' = $agent`) filtered that row
 * out, so the inbox MCP tool reported empty while the queue held a pending
 * entry — "inbox-ghost". Observed 2026-04-15 07:09-07:21 JST with CEO's
 * `<@lead-ama> テスト` post.
 *
 * Fix: run both queries in one BEGIN/COMMIT transaction on the same client.
 * Partial state (one half written, the other not) is no longer reachable;
 * failure rolls both back and surfaces a logged error instead of a silent
 * drop.
 *
 * Retry idempotency is preserved by the existing unique partial index
 * `uq_mq_agent_message` (agent_id, message_id) WHERE message_id IS NOT NULL.
 * A second call with the same message_id is absorbed by `ON CONFLICT DO
 * NOTHING`; `duplicateDedup` reports this via `rowCount = 0` so the caller
 * can log the dedup at the inbound level.
 *
 * See SSOT `docs/agent-com-message-queue-spec.md` §7.3.1 for the invariant
 * set this helper pins (atomic commit boundary, rollback semantics,
 * ordering of `pg_notify` relative to commit, retry idempotency).
 */

/**
 * Minimal client contract. `pg.Client` satisfies this, and mocked clients in
 * unit tests implement the same shape. Transactional semantics require both
 * 7b and 7d to run on the **same** connection — so callers must pass the
 * same `pg.Client`, not a connection-pool proxy that hands out different
 * sockets per query.
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
   * Pre-serialized JSON payload for message_queue.payload (jsonb). Callers
   * build this from the Discord event so the helper does not need the full
   * event shape — keeps the seam narrow for tests.
   */
  mqPayloadJson: string
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
  /** Populated on failure with the thrown error for caller-side logging. */
  error?: unknown
}

export async function persistInboundDelivery(
  client: InboundDeliveryClient,
  params: InboundDeliveryParams,
): Promise<InboundDeliveryResult> {
  const { receiverAgentId, messageId, mqPayloadJson } = params
  try {
    await client.query('BEGIN')
    // Explicit casts: node-postgres cannot infer the parameter types for
    // `jsonb_build_object('to', $1)` (text) or the `$2::uuid` `id`
    // comparison inside a transaction and raises PG 42P18 "could not
    // determine data type of parameter". Anchoring each parameter to its
    // column type side-steps the type-inference ambiguity.
    await client.query(
      `UPDATE agent_messages SET metadata = metadata || jsonb_build_object('to', $1::text) WHERE id = $2::uuid`,
      [receiverAgentId, messageId],
    )
    // message_queue.(agent_id, message_id, payload) are all `text`
    // columns (see prisma / DB schema); no uuid / jsonb cast.
    const mqIns = await client.query(
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
