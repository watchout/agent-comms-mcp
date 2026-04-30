-- Issue #278 (A) segment 3d reversal — restore agents.current_message_id.
-- Re-adds the column as nullable BIGINT (the original shape from
-- db/migrate.ts pre-segment-3d). On rollback, callers running pre-
-- Stage-B code expect to read NULL until they call `next` themselves;
-- in-flight Stage-B claims are NOT back-filled into this column. The
-- per-row claim columns (claimed_by/claimed_at/claim_expires_at) are
-- preserved for forward compatibility.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_message_id BIGINT;
