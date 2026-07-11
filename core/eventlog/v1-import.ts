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
  opts: {
    seats: string[]
    /**
     * MANDATORY created-at fence (ISO timestamp): only V1 rows created
     * strictly after this instant cross into V2. This is the garbage
     * barrier — historic pending residue (stale instructions, obsolete
     * chatter, abandoned dispatches) stays in V1 for explicit typed
     * disposition and is NEVER auto-imported or auto-answered. Same
     * fence discipline as the CP80 canary. The daemon defaults this to
     * its own boot time, so V2 only ever sees NEW work.
     */
    createdAfter: string
    limit?: number
  },
): Promise<ImportedRow[]> {
  if (opts.seats.length === 0) return []
  if (!opts.createdAfter || Number.isNaN(Date.parse(opts.createdAfter))) {
    throw new Error('importPendingV1Rows: createdAfter fence is mandatory (valid ISO timestamp)')
  }
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
       AND mq.created_at > $${opts.seats.length + 1}
     ORDER BY mq.created_at ASC
     LIMIT $${opts.seats.length + 2}`,
    [...opts.seats, opts.createdAfter, opts.limit ?? 50],
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

/** One V1 row that V2 has answered but whose V1 status is still open. */
export interface UnclosedAnsweredRow {
  seatId: string
  messageId: string
  turnId: string
}

/**
 * Durable recovery query (audit 4931107358 fix): the set of turns that have
 * a committed V2 `turn.completed` event whose corresponding V1 row is STILL
 * non-terminal. Derived entirely from durable state — the append-only log
 * joined to the live V1 row — so it CANNOT age out. A crash between the
 * completion event and the V1 close is healed the next time any daemon
 * instance runs this, whether that is 1 second or 1 week later. Replaces the
 * previous 10-minute `occurred_at` window, which silently dropped
 * completions older than the window and left V1 rows to be re-answered by
 * the legacy path.
 */
export async function findUnclosedAnsweredRows(
  db: DbAdapter,
  opts: { seats: string[]; limit?: number },
): Promise<UnclosedAnsweredRow[]> {
  if (opts.seats.length === 0) return []
  const seatParams = opts.seats.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.query<{ seat_id: string; turn_id: string; message_id: string }>(
    `SELECT c.seat_id, c.turn_id, mq.message_id
     FROM event_log c
     JOIN message_queue mq
       ON mq.message_id = split_part(c.turn_id, ':', 3)
      AND mq.agent_id = c.seat_id
     WHERE c.event_type = 'turn.completed'
       AND c.seat_id IN (${seatParams})
       AND mq.status IN ('pending', 'read')
     ORDER BY c.seq ASC
     LIMIT $${opts.seats.length + 1}`,
    [...opts.seats, opts.limit ?? 200],
  )
  return rows.map(r => ({ seatId: r.seat_id, messageId: r.message_id, turnId: r.turn_id }))
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
