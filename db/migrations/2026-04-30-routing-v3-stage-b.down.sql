-- Issue #323 prelude — drop the state-daemon trigger + function before
-- the claim columns disappear. The message_queue_notify trigger fires
-- AFTER UPDATE OF status / claim_expires_at, so dropping claim_expires_at
-- without first dropping the trigger leaves a dangling reference. Both
-- statements are IF EXISTS so rolling back a fresh DB that never saw
-- the state-daemon migration stays a no-op (CTO directive PR #330 cycle 6).
DROP TRIGGER IF EXISTS message_queue_notify ON message_queue;
DROP FUNCTION IF EXISTS notify_queue_event();

-- Issue #278 (A) — routing v3 stage B reversal.
-- Drops the per-row claim columns and the partial index. Idempotent: each
-- statement is guarded with IF EXISTS. Active claims are NOT preserved on
-- rollback (operators must drain or accept lost claim metadata; the
-- message_queue rows themselves remain in 'read' status and can be reclaimed
-- through the legacy current_message_id path until that column is re-added
-- by a paired data-restoration migration if needed).

DROP INDEX IF EXISTS idx_mq_expired_claims;

ALTER TABLE message_queue DROP COLUMN IF EXISTS claim_expires_at;
ALTER TABLE message_queue DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE message_queue DROP COLUMN IF EXISTS claimed_by;
