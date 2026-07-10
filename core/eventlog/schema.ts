// EventLogCore/v1 schema — single append-only table + derived-view indexes.
//
// V2 is a NEW core decoupled from V1's mutable-status machine (owner
// directive 2026-07-08, #794 comment 4911246042). This schema is therefore
// self-contained: `ensureEventLogSchema` is idempotent and creates only
// event_log objects. It never touches message_queue / outbound_queue.
// Wiring into the shared production DB happens at the M1 dual-write
// migration step, behind owner GO (protected surface).

import type { DbAdapter } from '../db/adapter'

// SQLite dialect (production fleet runs bun:sqlite; the DbAdapter keeps the
// PG door open — PG DDL is a cutover-time task, tracked in the design doc).
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS event_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    seat_id TEXT,
    seat_instance_id TEXT,
    conversation_id TEXT,
    causation_id TEXT,
    correlation_id TEXT,
    turn_id TEXT,
    reply_id TEXT,
    claim_epoch INTEGER,
    payload TEXT NOT NULL DEFAULT '{}'
  )`,

  // Append-only enforcement at the storage layer. Application bugs, ad-hoc
  // SQL, and future refactors all hit the same wall.
  `CREATE TRIGGER IF NOT EXISTS event_log_no_update
   BEFORE UPDATE ON event_log
   BEGIN SELECT RAISE(ABORT, 'event_log is append-only: UPDATE forbidden'); END`,
  `CREATE TRIGGER IF NOT EXISTS event_log_no_delete
   BEFORE DELETE ON event_log
   BEGIN SELECT RAISE(ABORT, 'event_log is append-only: DELETE forbidden'); END`,

  // Pull-claim race arbiter: one turn.claimed per (turn, epoch).
  // Losers of the conditional insert get a constraint error and back off.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_el_turn_claim
   ON event_log(turn_id, claim_epoch) WHERE event_type = 'turn.claimed'`,

  // Zero double-processing: at most one terminal completion per turn.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_el_turn_completed
   ON event_log(turn_id) WHERE event_type = 'turn.completed'`,

  // Outbox delivery race arbiter + zero double-send at the log layer.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_el_delivery_claim
   ON event_log(reply_id, claim_epoch) WHERE event_type = 'reply.delivery_claimed'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_el_reply_delivered
   ON event_log(reply_id) WHERE event_type = 'reply.delivered'`,

  // Projection query support.
  `CREATE INDEX IF NOT EXISTS idx_el_type_turn ON event_log(event_type, turn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_el_type_reply ON event_log(event_type, reply_id)`,
  `CREATE INDEX IF NOT EXISTS idx_el_conversation ON event_log(conversation_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_el_seat_type ON event_log(seat_id, event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_el_causation ON event_log(causation_id)`,
]

export async function ensureEventLogSchema(db: DbAdapter): Promise<void> {
  // PostgreSQL DDL is owned by db/migrate.ts (production migration path,
  // protected surface). ensureSchema is a fixture/local convenience for the
  // SQLite dialect only.
  if ((db.dialect ?? 'sqlite') === 'postgres') return
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.execute(stmt)
  }
}
