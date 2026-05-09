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
