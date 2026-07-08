// EventLogCore/v1 store — the only write path into event_log.
//
// Writes are INSERTs only. event_id conflicts are idempotent no-ops
// (inserted: false). Conflicts on the claim arbiters (uq_el_turn_claim /
// uq_el_delivery_claim / uq_el_turn_completed / uq_el_reply_delivered)
// surface as ClaimLostError so callers back off — that IS the pull-claim
// protocol: claim = appending the claim event, conditional insert wins.

import type { DbAdapter } from '../db/adapter'
import { ensureEventLogSchema } from './schema'
import {
  ClaimLostError,
  EVENT_TYPES,
  type AppendEvent,
  type AppendResult,
  type StoredEvent,
} from './types'

const INSERT_SQL = `
  INSERT INTO event_log (
    event_id, event_type, seat_id, seat_instance_id, conversation_id,
    causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT(event_id) DO NOTHING
`

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed|duplicate key value/i.test(msg)
}

function validate(input: AppendEvent): void {
  if (!input.eventId) throw new Error('eventId is required')
  if (!EVENT_TYPES.includes(input.eventType)) {
    throw new Error(`unknown event_type: ${input.eventType}`)
  }
}

export class EventLog {
  constructor(private db: DbAdapter) {}

  async ensureSchema(): Promise<void> {
    await ensureEventLogSchema(this.db)
  }

  /**
   * Append one event. Idempotent on event_id: appending the same event
   * twice returns { inserted: false } with the original row.
   * Throws ClaimLostError when a claim-arbiter unique index rejects the row.
   */
  async append(input: AppendEvent, db: DbAdapter = this.db): Promise<AppendResult> {
    validate(input)
    const params = [
      input.eventId,
      input.eventType,
      input.seatId ?? null,
      input.seatInstanceId ?? null,
      input.conversationId ?? null,
      input.causationId ?? null,
      input.correlationId ?? null,
      input.turnId ?? null,
      input.replyId ?? null,
      input.claimEpoch ?? null,
      JSON.stringify(input.payload ?? {}),
    ]
    let inserted: boolean
    try {
      const result = await db.execute(INSERT_SQL, params)
      inserted = result.rowCount > 0
    } catch (err) {
      if (isUniqueViolation(err)) throw new ClaimLostError(String(err))
      throw err
    }
    const event = await db.queryOne<StoredEvent>(
      'SELECT * FROM event_log WHERE event_id = $1',
      [input.eventId],
    )
    if (!event) throw new Error(`event ${input.eventId} not found after append`)
    return { inserted, event }
  }

  /**
   * Append several events atomically (all-or-nothing). Used by the
   * transactional-outbox path: turn.completed + reply.enqueued* commit in
   * one transaction, so there is no window where the outcome exists but the
   * outbound work does not (or vice versa).
   */
  async appendBatch(inputs: AppendEvent[]): Promise<AppendResult[]> {
    for (const input of inputs) validate(input)
    return this.db.transaction(async tx => {
      const results: AppendResult[] = []
      for (const input of inputs) {
        results.push(await this.append(input, tx))
      }
      return results
    })
  }

  /** Read events in replay order, strictly after `afterSeq`. */
  async readSince(afterSeq: number, limit = 1000): Promise<StoredEvent[]> {
    return this.db.query<StoredEvent>(
      'SELECT * FROM event_log WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
      [afterSeq, limit],
    )
  }

  async readConversation(conversationId: string): Promise<StoredEvent[]> {
    return this.db.query<StoredEvent>(
      'SELECT * FROM event_log WHERE conversation_id = $1 ORDER BY seq ASC',
      [conversationId],
    )
  }

  async getByEventId(eventId: string): Promise<StoredEvent | null> {
    return this.db.queryOne<StoredEvent>(
      'SELECT * FROM event_log WHERE event_id = $1',
      [eventId],
    )
  }

  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM event_log')
    return row?.n ?? 0
  }
}
