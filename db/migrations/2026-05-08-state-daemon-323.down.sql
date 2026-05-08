-- Down migration for Issue #323 state-daemon schema. Removes trigger first so
-- subsequent UPDATEs do not pg_notify into a dropped column. The new columns
-- and indexes are dropped IF EXISTS so partial rollbacks are idempotent.

DROP TRIGGER IF EXISTS message_queue_notify ON message_queue;
DROP FUNCTION IF EXISTS notify_queue_event();

DROP INDEX IF EXISTS idx_mq_pending_stale;
DROP INDEX IF EXISTS idx_mq_read_expired;

ALTER TABLE message_queue DROP COLUMN IF EXISTS last_wake_attempt_at;
ALTER TABLE message_queue DROP COLUMN IF EXISTS last_heartbeat_at;
