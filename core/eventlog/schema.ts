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

  // K1 active read model. This table is derived-only: append triggers keep it
  // current and rebuildActiveTurnProjection can recreate it from event_log.
  `CREATE TABLE IF NOT EXISTS event_log_turn_projection (
    turn_id TEXT PRIMARY KEY,
    received_event_id TEXT NOT NULL UNIQUE,
    seat_id TEXT NOT NULL,
    conversation_id TEXT,
    correlation_id TEXT,
    received_seq INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    message_id TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    availability TEXT NOT NULL CHECK (availability IN ('available', 'claimed', 'completed')),
    claim_event_id TEXT,
    claim_epoch INTEGER,
    fencing_token INTEGER,
    claim_profile TEXT,
    claimed_by_seat TEXT,
    claimed_by_instance TEXT,
    lease_expires_at TEXT,
    terminal_event_id TEXT,
    updated_seq INTEGER NOT NULL
  )`,

  // Append-only enforcement at the storage layer. Application bugs, ad-hoc
  // SQL, and future refactors all hit the same wall.
  `CREATE TRIGGER IF NOT EXISTS event_log_no_update
   BEFORE UPDATE ON event_log
   BEGIN SELECT RAISE(ABORT, 'event_log is append-only: UPDATE forbidden'); END`,
  `CREATE TRIGGER IF NOT EXISTS event_log_no_delete
   BEFORE DELETE ON event_log
   BEGIN SELECT RAISE(ABORT, 'event_log is append-only: DELETE forbidden'); END`,

  `CREATE TRIGGER IF NOT EXISTS event_log_k1_project_received
   AFTER INSERT ON event_log
   WHEN NEW.event_type = 'message.received'
   BEGIN
     INSERT OR IGNORE INTO event_log_turn_projection (
       turn_id, received_event_id, seat_id, conversation_id, correlation_id,
       received_seq, received_at, message_id, priority, availability, updated_seq
     ) VALUES (
       NEW.turn_id, NEW.event_id, NEW.seat_id, NEW.conversation_id, NEW.correlation_id,
       NEW.seq, NEW.occurred_at, json_extract(NEW.payload, '$.message_id'),
       COALESCE(CAST(json_extract(NEW.payload, '$.priority') AS INTEGER), 0),
       'available', NEW.seq
     );
   END`,

  `CREATE TRIGGER IF NOT EXISTS event_log_k1_project_claimed
   AFTER INSERT ON event_log
   WHEN NEW.event_type = 'turn.claimed'
   BEGIN
     UPDATE event_log_turn_projection
        SET availability = 'claimed',
            claim_event_id = NEW.event_id,
            claim_epoch = NEW.claim_epoch,
            fencing_token = CAST(json_extract(NEW.payload, '$.fencing_token') AS INTEGER),
            claim_profile = json_extract(NEW.payload, '$.claim_profile'),
            claimed_by_seat = NEW.seat_id,
            claimed_by_instance = NEW.seat_instance_id,
            lease_expires_at = json_extract(NEW.payload, '$.lease_expires_at'),
            terminal_event_id = NULL,
            updated_seq = NEW.seq
      WHERE turn_id = NEW.turn_id
        AND availability = 'available'
        AND NEW.claim_epoch = COALESCE(claim_epoch + 1, 0);
   END`,

  `CREATE TRIGGER IF NOT EXISTS event_log_k1_project_released
   AFTER INSERT ON event_log
   WHEN NEW.event_type = 'turn.claim_released'
   BEGIN
     UPDATE event_log_turn_projection
        SET availability = 'available',
            claim_event_id = NULL,
            claim_profile = NULL,
            claimed_by_seat = NULL,
            claimed_by_instance = NULL,
            lease_expires_at = NULL,
            terminal_event_id = NULL,
            updated_seq = NEW.seq
      WHERE turn_id = NEW.turn_id
        AND availability = 'claimed'
        AND claim_event_id = NEW.causation_id
        AND claim_epoch = NEW.claim_epoch
        AND (
          claim_profile IS NOT 'postgres_multi_worker_v1'
          OR fencing_token = CAST(json_extract(NEW.payload, '$.fencing_token') AS INTEGER)
        );
   END`,

  `CREATE TRIGGER IF NOT EXISTS event_log_k1_project_completed
   AFTER INSERT ON event_log
   WHEN NEW.event_type = 'turn.completed'
   BEGIN
     UPDATE event_log_turn_projection
        SET availability = 'completed',
            terminal_event_id = NEW.event_id,
            updated_seq = NEW.seq
      WHERE turn_id = NEW.turn_id
        AND availability = 'claimed'
        AND claim_event_id = NEW.causation_id
        AND (NEW.claim_epoch IS NULL OR claim_epoch = NEW.claim_epoch)
        AND (
          claim_profile IS NOT 'postgres_multi_worker_v1'
          OR fencing_token = CAST(json_extract(NEW.payload, '$.fencing_token') AS INTEGER)
        );
   END`,

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
  `CREATE INDEX IF NOT EXISTS idx_el_turn_projection_claimable
   ON event_log_turn_projection(seat_id, availability, priority DESC, received_seq ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_el_turn_projection_expired
   ON event_log_turn_projection(seat_id, lease_expires_at, received_seq)
   WHERE availability = 'claimed'`,
  `CREATE INDEX IF NOT EXISTS idx_el_turn_projection_conversation
   ON event_log_turn_projection(seat_id, conversation_id, received_seq)
   WHERE availability <> 'completed'`,
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
