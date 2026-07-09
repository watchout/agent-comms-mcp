// EventLogCore/v1 — V1→V2 receive importer (cutover bridge).
//
// Until every listener process restarts on the M1 dual-write code, inbound
// work lands only in V1's message_queue. This importer mirrors PENDING V1
// rows for allowlisted seats into the V2 log as message.received events —
// using the SAME deterministic event ids the M1 dual-write writes
// (recv:<seat>:<messageId>), so when a restarted listener dual-writes the
// same message, ON CONFLICT (event_id) DO NOTHING makes the two paths
// converge instead of duplicating. Production-proven by the exact-fenced
// live pilot (#794 comment 4924913779); this is the same operation with a
// seat allowlist instead of explicit queue ids.
//
// V1 is READ-ONLY here. Closing the V1 row after V2 answers it is the
// worker daemon's separate, typed step (skip with an evidence reason).

import type { DbAdapter } from '../db/adapter'
import { receiveMessage } from './turns'

export interface ImportedRow {
  v1QueueId: number
  seatId: string
  messageId: string
}

export async function importPendingV1Rows(
  db: DbAdapter,
  opts: { seats: string[]; limit?: number },
): Promise<ImportedRow[]> {
  if (opts.seats.length === 0) return []
  const seatParams = opts.seats.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.query<{
    id: number; agent_id: string; message_id: string
    channel_id: string | null; thread_id: string | null; author_id: string; content: string
  }>(
    `SELECT mq.id, mq.agent_id, mq.message_id,
            am.channel_id, am.thread_id, am.author_id, am.content
     FROM message_queue mq JOIN agent_messages am ON am.id::text = mq.message_id
     WHERE mq.status = 'pending' AND mq.message_id IS NOT NULL
       AND mq.agent_id IN (${seatParams})
     ORDER BY mq.created_at ASC
     LIMIT $${opts.seats.length + 1}`,
    [...opts.seats, opts.limit ?? 50],
  )
  const imported: ImportedRow[] = []
  for (const row of rows) {
    const result = await receiveMessage(db, {
      messageId: row.message_id,
      seatId: row.agent_id,
      conversationId: row.thread_id ?? row.channel_id ?? 'unknown',
      payload: {
        channel_id: row.channel_id, thread_id: row.thread_id,
        author_id: row.author_id, content: row.content,
        v1_queue_id: row.id, source: 'v1_import_bridge',
      },
    })
    // inserted=false = already known to V2 (dual-write or a prior import
    // pass) — idempotent, not an error
    if (result.inserted) {
      imported.push({ v1QueueId: row.id, seatId: row.agent_id, messageId: row.message_id })
    }
  }
  return imported
}

/**
 * Typed V1 closure for a turn V2 has terminal-closed: mirrors the operator
 * `skip` semantics (terminal state + evidence reason) without claiming.
 * Called by the daemon only AFTER the V2 completion event is committed.
 */
export async function closeAnsweredV1Row(
  db: DbAdapter,
  opts: { seatId: string; messageId: string; evidenceRef: string },
): Promise<boolean> {
  const r = await db.execute(
    `UPDATE message_queue
     SET status = 'skipped',
         failed_reason = $3,
         done_at = now()
     WHERE agent_id = $1 AND message_id = $2 AND status IN ('pending', 'read')`,
    [opts.seatId, opts.messageId, `answered via V2 (${opts.evidenceRef})`],
  )
  return r.rowCount > 0
}
