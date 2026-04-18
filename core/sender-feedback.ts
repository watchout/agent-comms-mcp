/**
 * Sender-delivery-status feedback (spec §8.2).
 *
 * Motivation: when A sends to B, the delivery is synchronous only if B is
 * `idle`. If B is `busy` or `disconnected`, B won't see the message until
 * some later event — but A has no way to know that. Spec §8.2 requires that
 * we insert a system-authored row into A's own `message_queue` describing
 * the target's state so A's next `agent-com next` surfaces the information.
 *
 * Contract:
 *   - `idle` target → no-op (immediate delivery; nothing to feed back).
 *   - `busy` target → `system_info` row: "⏳ {targetId} はタスク処理中, キュー待ち N 件".
 *   - `disconnected` target → `system_error` row: "⚠️ {targetId} はオフラインです...".
 *   - Unknown / unregistered sender (senderId not in `agents`) → no-op so
 *     Discord-human posts don't fan out phantom feedback rows.
 *
 * All I/O is best-effort: failure writes to stderr but never throws — feedback
 * is advisory, so a DB hiccup must not fail the outer send/notify/inbound
 * flow. The only caller-visible side effect is the optional message_queue row.
 */

/**
 * Minimal DB shape — matches `core/route-message-db.DbAdapter` so the same
 * instance returned by `coreDbAdapter()` works here without adaptation.
 */
export interface SenderFeedbackDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>
}

export interface NotifyDeliveryStatusArgs {
  /** agent_id of the sender (NOT a Discord user id). Required to insert a row. */
  senderId: string
  /** agent_id of the target — looked up in the `agents` table for status. */
  targetId: string
  /** agent_messages.id of the source message, for audit / traceability. Optional. */
  messageId?: string | null
}

export async function notifySenderOfDeliveryStatus(
  db: SenderFeedbackDb,
  args: NotifyDeliveryStatusArgs,
): Promise<{ emitted: 'system_info' | 'system_error' | null; reason?: string }> {
  const { senderId, targetId, messageId } = args
  if (!senderId || !targetId) {
    return { emitted: null, reason: 'missing-args' }
  }
  if (senderId === targetId) {
    // Never echo to self.
    return { emitted: null, reason: 'self' }
  }

  try {
    const senderRow = await db.query<{ agent_id: string }>(
      `SELECT agent_id FROM agents WHERE agent_id = $1`,
      [senderId],
    )
    if (senderRow.rows.length === 0) {
      return { emitted: null, reason: 'sender-not-registered' }
    }

    const targetRow = await db.query<{ status: string | null }>(
      `SELECT status FROM agents WHERE agent_id = $1`,
      [targetId],
    )
    const targetStatus = targetRow.rows[0]?.status ?? null
    if (targetStatus === null || targetStatus === undefined) {
      return { emitted: null, reason: 'target-unknown' }
    }
    if (targetStatus === 'idle' || targetStatus === 'online') {
      return { emitted: null, reason: 'target-idle' }
    }
    if (targetStatus !== 'busy' && targetStatus !== 'disconnected') {
      // Unknown status keyword — treat as idle to avoid spamming on new states.
      return { emitted: null, reason: `target-status-${targetStatus}` }
    }

    let content: string
    let messageType: 'system_info' | 'system_error'
    if (targetStatus === 'busy') {
      const pendingRow = await db.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM message_queue WHERE agent_id = $1 AND status IN ('pending', 'read')`,
        [targetId],
      )
      const pendingRaw = pendingRow.rows[0]?.n ?? 0
      const pending = typeof pendingRaw === 'string' ? parseInt(pendingRaw, 10) : pendingRaw
      content = `⏳ ${targetId} はタスク処理中、キュー待ち ${pending} 件`
      messageType = 'system_info'
    } else {
      content = `⚠️ ${targetId} はオフラインです、セッション復旧後に配信されます`
      messageType = 'system_error'
    }

    const payload = JSON.stringify({
      author_id: 'system',
      content,
      message_type: messageType,
      channel_name: 'system',
      target_agent_id: targetId,
      source_message_id: messageId ?? null,
      ts: new Date().toISOString(),
    })

    // message_id is NULL for system-originated rows (DDL comment:
    // "agent_messages.id (NULL for system messages)").
    await db.query(
      `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, NULL, $2)`,
      [senderId, payload],
    )
    return { emitted: messageType }
  } catch (err) {
    process.stderr.write(`agent-comms: notifySenderOfDeliveryStatus failed (non-fatal): ${err}\n`)
    return { emitted: null, reason: 'error' }
  }
}
