-- Issue #323 — state-daemon DB schema (spec v0.6 §7).
-- Idempotent: ADD COLUMN IF NOT EXISTS guards each ALTER.
--
-- Adds:
--   - message_queue.last_wake_attempt_at (TIMESTAMPTZ) — duplicate wake suppression
--   - message_queue.last_heartbeat_at    (TIMESTAMPTZ) — claim refresh observation
--   - failed_reason='STALE_DISPATCH'                  — new logical value (text column,
--                                                       no enum, accepted by app code only)
--   - notify_queue_event() trigger function + message_queue_notify trigger —
--     pg_notify('queue_event', ...) on AFTER INSERT OR UPDATE OF (status,
--     claim_expires_at) so the daemon's LISTEN can dispatch immediately.

DO $$ BEGIN
  ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS last_wake_attempt_at TIMESTAMPTZ;
  ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- pg_notify trigger function. Uses NEW only; payload kept small (id / agent_id /
-- status / claim_expires_at) — daemon re-fetches the row when it processes the
-- event so a stale snapshot in the payload cannot cause action drift.
CREATE OR REPLACE FUNCTION notify_queue_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('queue_event', json_build_object(
    'op', TG_OP,
    'id', NEW.id,
    'agent_id', NEW.agent_id,
    'status', NEW.status,
    'claim_expires_at', NEW.claim_expires_at
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_queue_notify ON message_queue;
CREATE TRIGGER message_queue_notify
  AFTER INSERT OR UPDATE OF status, claim_expires_at ON message_queue
  FOR EACH ROW EXECUTE FUNCTION notify_queue_event();

-- Indexes for sweep queries (state-daemon §4.3 row 2-6 batch evaluation).
CREATE INDEX IF NOT EXISTS idx_mq_pending_stale
  ON message_queue(status, created_at)
  WHERE status = 'pending';

DROP INDEX IF EXISTS idx_mq_read_expired;
CREATE INDEX IF NOT EXISTS idx_mq_read_expired
  ON message_queue(status, claim_expires_at)
  WHERE status = 'received';
