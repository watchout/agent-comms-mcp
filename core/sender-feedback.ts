import { inspectHostRuntime, type HostRuntimeInspector } from './host-runtime-observer'

/** Best-effort delivery advisory from logical claims and fresh OS observation.
 * Busy emits an out-of-band signal; only confirmed absence enqueues an error.
 * Historical agent status and copied physical diagnostics are never authority.
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
  /** Logical recipient identity. */
  targetId: string
  /** agent_messages.id of the source message, for audit / traceability. Optional. */
  messageId?: string | null
  inspect?: HostRuntimeInspector
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

    const targetRow = await db.query<{ agent_id: string }>(
      `SELECT agent_id FROM agents WHERE agent_id = $1`, [targetId],
    )
    if (targetRow.rows.length === 0) return { emitted: null, reason: 'target-unknown' }
    const claims = await db.query<{ id: string | number }>(
      `SELECT id FROM message_queue WHERE agent_id=$1 AND claimed_by=$1
        AND status IN ('received','in_progress') AND claim_expires_at > clock_timestamp() LIMIT 1`,
      [targetId],
    )
    if (claims.rows.length > 0) {
      // Issue #251 (b) — skip the queue INSERT for the busy /
      // system_info notification. It's an out-of-band signal to the
      // sender ("target is processing, N queued"), not an actionable
      // message; queueing it just to wake the sender bot adds noise
      // (observed 447 such rows over 7d). The function still returns
      // emitted='system_info' so any caller observability stays
      // intact, with reason='queue-skip' to disambiguate.
      return { emitted: 'system_info', reason: 'queue-skip' }
    }
    const current = (args.inspect ?? inspectHostRuntime)({agentId: targetId})
    if (current.observations.length > 0) return {emitted: null, reason: 'target-idle'}
    if (current.reasonCode !== 'NO_LIVE_RUNTIME') return {emitted: null, reason: 'target-unavailable'}
    const content = `⚠️ ${targetId} はオフラインです、セッション復旧後に配信されます`
    const messageType: 'system_error' = 'system_error'

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
