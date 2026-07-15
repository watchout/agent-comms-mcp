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
import { receiveMessage, turnIdFor } from './turns'
import { parseEventPayload } from './types'

export interface ImportedRow {
  v1QueueId: number
  seatId: string
  messageId: string
}

export interface ExactV1QueueTuple {
  seatId: 'aun'
  queueId: number
  messageId: string
  createdAfter: string
}

export interface ExactV1QueueRow extends ImportedRow {
  channelId: string | null
  threadId: string | null
  authorId: string
  content: string
  createdAt: string
  status: string
}

export class ExactV1TupleMismatchError extends Error {
  readonly code = 'EXACT_V1_TUPLE_MISMATCH' as const
}

function assertExactTuple(tuple: ExactV1QueueTuple): void {
  if (tuple.seatId !== 'aun') throw new ExactV1TupleMismatchError('exact canary seat must be aun')
  if (!Number.isSafeInteger(tuple.queueId) || tuple.queueId <= 0) {
    throw new ExactV1TupleMismatchError('exact canary queueId must be a positive safe integer')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tuple.messageId)) {
    throw new ExactV1TupleMismatchError('exact canary messageId must be a UUID')
  }
  if (!tuple.createdAfter || Number.isNaN(Date.parse(tuple.createdAfter))) {
    throw new ExactV1TupleMismatchError('exact canary createdAfter must be a valid timestamp')
  }
}

async function selectExactPendingV1Row(
  db: DbAdapter,
  tuple: ExactV1QueueTuple,
  lock: boolean,
): Promise<ExactV1QueueRow> {
  assertExactTuple(tuple)
  const rows = await db.query<{
    id: number
    agent_id: string
    message_id: string
    status: string
    created_at: string | Date
    channel_id: string | null
    thread_id: string | null
    author_id: string
    content: string
  }>(
    `SELECT mq.id, mq.agent_id, mq.message_id, mq.status, mq.created_at,
            am.channel_id, am.thread_id, am.author_id, am.content
     FROM message_queue mq
     JOIN agent_messages am ON am.id::text = mq.message_id
     WHERE mq.id = $1
       AND mq.message_id = $2
       AND mq.agent_id = $3
       AND mq.status = 'pending'
       AND mq.created_at > $4
     ${lock ? 'FOR UPDATE OF mq' : ''}`,
    [tuple.queueId, tuple.messageId, tuple.seatId, tuple.createdAfter],
  )
  if (rows.length !== 1) {
    throw new ExactV1TupleMismatchError(
      `expected exactly one pending V1 row for queue=${tuple.queueId} message=${tuple.messageId} seat=${tuple.seatId}`,
    )
  }
  const row = rows[0]
  return {
    v1QueueId: Number(row.id),
    seatId: row.agent_id,
    messageId: row.message_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    authorId: row.author_id,
    content: row.content,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    status: row.status,
  }
}

/** Read-only negative-phase predicate. It never appends or mutates. */
export async function readExactPendingV1Row(
  db: DbAdapter,
  tuple: ExactV1QueueTuple,
): Promise<ExactV1QueueRow> {
  return selectExactPendingV1Row(db, tuple, false)
}

/**
 * Import exactly one V1 tuple. The qualifying row lock and deterministic
 * message.received append share one transaction, so no seat-wide scan or
 * time-of-check/time-of-use gap can widen the canary target.
 */
export async function importExactPendingV1Row(
  db: DbAdapter,
  tuple: ExactV1QueueTuple,
): Promise<ExactV1QueueRow & { inserted: boolean; turnId: string }> {
  return db.transaction(async tx => {
    const row = await selectExactPendingV1Row(tx, tuple, true)
    const result = await receiveMessage(tx, {
      messageId: row.messageId,
      seatId: row.seatId,
      conversationId: row.threadId ?? row.channelId ?? 'unknown',
      payload: {
        channel_id: row.channelId,
        thread_id: row.threadId,
        author_id: row.authorId,
        content: row.content,
        v1_queue_id: row.v1QueueId,
        v1_created_at: row.createdAt,
        v1_created_after: tuple.createdAfter,
        source: 'v1_exact_canary',
      },
    }, tx)
    return {
      ...row,
      inserted: result.inserted,
      turnId: turnIdFor(row.seatId, row.messageId),
    }
  })
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
  opts: { seats: string[]; limit?: number; batchSize?: number },
): Promise<UnclosedAnsweredRow[]> {
  if (opts.seats.length === 0) return []
  const resultLimit = opts.limit ?? 200
  const batchSize = opts.batchSize ?? 500

  // Dialect-safe (no split_part) AND starvation-free (audit cycle-3 fix).
  // turnIdFor is deterministic, so candidate turn_ids are computed in
  // application code. Critically, we PAGINATE through ALL pending
  // candidates by id cursor rather than taking a fixed oldest-N prefix:
  // the garbage barrier deliberately leaves historic residue in `pending`,
  // and a fixed prefix of that residue would permanently hide a later row
  // that DOES have a committed completion (head-of-line starvation). The
  // bound is on the MATCHED result count, so a completed row is always
  // reached regardless of how much unmatched residue precedes it.
  const seatParams = opts.seats.map((_, i) => `$${i + 1}`).join(', ')
  const results: UnclosedAnsweredRow[] = []
  let afterId = 0

  for (;;) {
    const pending = await db.query<{ id: number; agent_id: string; message_id: string }>(
      `SELECT id, agent_id, message_id FROM message_queue
       WHERE status IN ('pending', 'read')
         AND message_id IS NOT NULL
         AND agent_id IN (${seatParams})
         AND id > $${opts.seats.length + 1}
       ORDER BY id ASC
       LIMIT $${opts.seats.length + 2}`,
      [...opts.seats, afterId, batchSize],
    )
    if (pending.length === 0) break
    afterId = pending[pending.length - 1].id

    const turnIds = pending.map(p => turnIdFor(p.agent_id, p.message_id))
    const tParams = turnIds.map((_, i) => `$${i + 1}`).join(', ')
    const completed = await db.query<{ turn_id: string }>(
      `SELECT turn_id FROM event_log
       WHERE event_type = 'turn.completed' AND turn_id IN (${tParams})`,
      turnIds,
    )
    const completedSet = new Set(completed.map(c => c.turn_id))
    for (const p of pending) {
      const tid = turnIdFor(p.agent_id, p.message_id)
      if (completedSet.has(tid)) {
        results.push({ seatId: p.agent_id, messageId: p.message_id, turnId: tid })
        if (results.length >= resultLimit) return results
      }
    }
    if (pending.length < batchSize) break // last page reached
  }
  return results
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

/**
 * Exact-target V1 typed closure used only by the bounded canary executable.
 * Queue id, message id, seat, created-after fence, pending status, and the
 * committed no-reply completion are rechecked in the same transaction as
 * the one permitted V1 mutation.
 */
export async function closeExactAnsweredV1Row(
  db: DbAdapter,
  opts: ExactV1QueueTuple & { turnId: string; evidenceRef: string },
): Promise<boolean> {
  assertExactTuple(opts)
  const expectedTurnId = turnIdFor(opts.seatId, opts.messageId)
  if (opts.turnId !== expectedTurnId) {
    throw new ExactV1TupleMismatchError(`turnId differs from exact tuple: ${opts.turnId}`)
  }
  if (!opts.evidenceRef.trim()) throw new ExactV1TupleMismatchError('evidenceRef is required')
  const reason = `answered via V2 exact canary (${opts.evidenceRef})`

  return db.transaction(async tx => {
    const rows = await tx.query<{
      id: number
      status: string
      failed_reason: string | null
    }>(
      `SELECT id, status, failed_reason
       FROM message_queue
       WHERE id = $1
         AND message_id = $2
         AND agent_id = $3
         AND created_at > $4
       FOR UPDATE`,
      [opts.queueId, opts.messageId, opts.seatId, opts.createdAfter],
    )
    if (rows.length !== 1) {
      throw new ExactV1TupleMismatchError('exact V1 close tuple is absent or stale')
    }
    const row = rows[0]
    if (row.status === 'skipped' && row.failed_reason === reason) return false
    if (row.status !== 'pending') {
      throw new ExactV1TupleMismatchError(`exact V1 close requires pending status; got ${row.status}`)
    }

    const completions = await tx.query<{ payload: unknown }>(
      `SELECT payload FROM event_log
       WHERE event_type = 'turn.completed'
         AND turn_id = $1
         AND seat_id = $2`,
      [opts.turnId, opts.seatId],
    )
    if (completions.length !== 1) {
      throw new ExactV1TupleMismatchError('exact V1 close requires one committed target completion')
    }
    const payload = parseEventPayload<Record<string, unknown>>(completions[0].payload)
    if (payload.outcome !== 'no_reply') {
      throw new ExactV1TupleMismatchError('exact V1 close requires deterministic no_reply completion')
    }

    const updated = await tx.execute(
      `UPDATE message_queue
       SET status = 'skipped', failed_reason = $5, done_at = now()
       WHERE id = $1
         AND message_id = $2
         AND agent_id = $3
         AND created_at > $4
         AND status = 'pending'`,
      [opts.queueId, opts.messageId, opts.seatId, opts.createdAfter, reason],
    )
    if (updated.rowCount !== 1) {
      throw new ExactV1TupleMismatchError('exact V1 close lost its mutation-time fence')
    }
    return true
  })
}
