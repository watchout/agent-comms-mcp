// EventLogCore/v1 projections — queue_view / inbox_view / thread_view /
// outbox_view, all derived purely from event_log.
//
// There is deliberately no materialized state here: every view is a query
// over the append-only log, so "rebuild from the log" is not a recovery
// procedure — it is the only way state ever exists. Kill the whole fleet,
// restart, and these queries return the exact same truth (the fleet-kill
// fixture proves this end to end).
//
// Stall detection follows the same rule: "stuck" is not an elapsed-time
// timer, it is the query "open turns" (optionally filtered older-than-T).

import type { DbAdapter } from '../db/adapter'

// json extraction differs by dialect: SQLite stores payload as TEXT
// (json_extract), PostgreSQL as JSONB (->> operator). Views substitute the
// right form at query time from the adapter's dialect hint.
function jsonText(db: DbAdapter, column: string, key: string): string {
  return (db.dialect ?? 'sqlite') === 'postgres'
    ? `${column}::jsonb->>'${key}'`
    : `json_extract(${column}, '$.${key}')`
}
import type {
  OutboxViewRow,
  QueueViewRow,
  StoredEvent,
  ThreadViewNode,
} from './types'

// A turn is OPEN iff it has a message.received event and no turn.completed.
// Its ACTIVE claim is the max-epoch turn.claimed with no matching
// turn.claim_released (a completed turn has no active claim by definition —
// completion closes the turn entirely).
const queueViewSql = (db: DbAdapter) => `
  SELECT
    r.turn_id,
    r.seat_id,
    r.conversation_id,
    r.seq AS received_seq,
    r.event_id AS received_event_id,
    r.occurred_at AS received_at,
    ${jsonText(db, 'r.payload', 'message_id')} AS message_id,
    c.event_id AS claim_event_id,
    c.claim_epoch AS claim_epoch,
    c.seat_id AS claimed_by_seat,
    c.seat_instance_id AS claimed_by_instance,
    c.seq AS claim_seq
  FROM event_log r
  LEFT JOIN event_log c
    ON c.event_type = 'turn.claimed'
   AND c.turn_id = r.turn_id
   AND c.claim_epoch = (
     SELECT MAX(c2.claim_epoch) FROM event_log c2
     WHERE c2.event_type = 'turn.claimed' AND c2.turn_id = r.turn_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM event_log rel
     WHERE rel.event_type = 'turn.claim_released'
       AND rel.turn_id = r.turn_id
       AND rel.claim_epoch = c.claim_epoch
   )
  WHERE r.event_type = 'message.received'
    AND NOT EXISTS (
      SELECT 1 FROM event_log t
      WHERE t.event_type = 'turn.completed' AND t.turn_id = r.turn_id
    )
`

export async function queueView(db: DbAdapter): Promise<QueueViewRow[]> {
  return db.query<QueueViewRow>(`${queueViewSql(db)} ORDER BY r.seq ASC`)
}

/** Per-seat pending work: open turns addressed to this seat. */
export async function inboxView(db: DbAdapter, seatId: string): Promise<QueueViewRow[]> {
  return db.query<QueueViewRow>(
    `${queueViewSql(db)} AND r.seat_id = $1 ORDER BY r.seq ASC`,
    [seatId],
  )
}

/**
 * Stall detection = counting unfinished work from the log, not timers.
 * `olderThan` (ISO timestamp) is an optional data filter ("open turns older
 * than T" — a query parameter, not a liveness mechanism).
 */
export async function openTurns(
  db: DbAdapter,
  opts: { seatId?: string; olderThan?: string } = {},
): Promise<QueueViewRow[]> {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.seatId) {
    params.push(opts.seatId)
    clauses.push(`AND r.seat_id = $${params.length}`)
  }
  if (opts.olderThan) {
    params.push(opts.olderThan)
    clauses.push(`AND r.occurred_at < $${params.length}`)
  }
  return db.query<QueueViewRow>(
    `${queueViewSql(db)} ${clauses.join(' ')} ORDER BY r.seq ASC`,
    params,
  )
}

export async function openTurnCount(
  db: DbAdapter,
  opts: { seatId?: string; olderThan?: string } = {},
): Promise<number> {
  const rows = await openTurns(db, opts)
  return rows.length
}

/**
 * Claimable turns for a seat, honoring per-conversation serialization:
 * within a conversation only the EARLIEST open turn is offered, and only
 * while unclaimed. Turns without a conversation are independent work orders
 * (freely claimable by seat pools).
 */
export async function claimableTurns(db: DbAdapter, seatId: string): Promise<QueueViewRow[]> {
  const rows = await inboxView(db, seatId)
  const earliestOpenByConversation = new Map<string, number>()
  for (const row of rows) {
    if (!row.conversation_id) continue
    const cur = earliestOpenByConversation.get(row.conversation_id)
    if (cur === undefined || row.received_seq < cur) {
      earliestOpenByConversation.set(row.conversation_id, row.received_seq)
    }
  }
  return rows.filter(row => {
    if (row.claim_event_id !== null) return false
    if (!row.conversation_id) return true
    return earliestOpenByConversation.get(row.conversation_id) === row.received_seq
  })
}

// A reply is PENDING iff enqueued, not delivered, not permanently failed.
// Its active delivery claim is the max-epoch reply.delivery_claimed whose
// epoch has no reply.failed row (a retryable failure releases the epoch).
const outboxViewSql = (db: DbAdapter) => `
  SELECT
    q.reply_id,
    q.seat_id,
    q.conversation_id,
    q.turn_id,
    q.seq AS enqueued_seq,
    q.event_id AS enqueued_event_id,
    q.occurred_at AS enqueued_at,
    q.payload,
    (SELECT COUNT(*) FROM event_log a
      WHERE a.event_type = 'reply.delivery_claimed' AND a.reply_id = q.reply_id
    ) AS attempts,
    dc.event_id AS delivery_claim_event_id,
    dc.claim_epoch AS delivery_claim_epoch,
    dc.seat_id AS claimed_by_dispatcher,
    dc.seat_instance_id AS claimed_by_instance
  FROM event_log q
  LEFT JOIN event_log dc
    ON dc.event_type = 'reply.delivery_claimed'
   AND dc.reply_id = q.reply_id
   AND dc.claim_epoch = (
     SELECT MAX(x.claim_epoch) FROM event_log x
     WHERE x.event_type = 'reply.delivery_claimed' AND x.reply_id = q.reply_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM event_log rf
     WHERE rf.event_type = 'reply.failed'
       AND rf.reply_id = q.reply_id
       AND rf.claim_epoch = dc.claim_epoch
   )
  WHERE q.event_type = 'reply.enqueued'
    AND NOT EXISTS (
      SELECT 1 FROM event_log d
      WHERE d.event_type = 'reply.delivered' AND d.reply_id = q.reply_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM event_log pf
      WHERE pf.event_type = 'reply.failed'
        AND pf.reply_id = q.reply_id
        AND ${jsonText(db, 'pf.payload', 'kind')} = 'permanent'
    )
`

export async function outboxView(db: DbAdapter): Promise<OutboxViewRow[]> {
  return db.query<OutboxViewRow>(`${outboxViewSql(db)} ORDER BY q.seq ASC`)
}

export async function pendingDeliveries(db: DbAdapter): Promise<OutboxViewRow[]> {
  const rows = await outboxView(db)
  return rows.filter(r => r.delivery_claim_event_id === null)
}

/**
 * thread_view: causation-chain tree rooted at `rootEventId`. Works for any
 * interface — the chain lives in the log, not in Discord threads.
 */
export async function threadView(
  db: DbAdapter,
  rootEventId: string,
): Promise<ThreadViewNode | null> {
  const rows = await db.query<StoredEvent>(
    `WITH RECURSIVE chain AS (
       SELECT * FROM event_log WHERE event_id = $1
       UNION ALL
       SELECT e.* FROM event_log e JOIN chain ch ON e.causation_id = ch.event_id
     )
     SELECT * FROM chain ORDER BY seq ASC`,
    [rootEventId],
  )
  if (rows.length === 0) return null
  const nodes = new Map<string, ThreadViewNode>()
  for (const event of rows) {
    nodes.set(event.event_id, { event, children: [] })
  }
  let root: ThreadViewNode | null = null
  for (const event of rows) {
    const node = nodes.get(event.event_id)!
    if (event.event_id === rootEventId) {
      root = node
    } else if (event.causation_id && nodes.has(event.causation_id)) {
      nodes.get(event.causation_id)!.children.push(node)
    }
  }
  return root
}
