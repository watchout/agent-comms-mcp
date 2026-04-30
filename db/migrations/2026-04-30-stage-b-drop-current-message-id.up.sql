-- Issue #278 (A) segment 3d — drop agents.current_message_id.
-- Component A completion: with the per-row claim model fully wired
-- (next stamps claimed_by/at/expires_at, send/fail/skip/reclaim drive
-- off message_queue rather than agents.current_message_id), the
-- single-slot column is the last vestige of the legacy in-flight
-- pointer. This migration drops it.
--
-- Idempotent: ALTER TABLE ... DROP COLUMN IF EXISTS is a no-op when
-- the column has already been dropped, so re-runs are safe.

ALTER TABLE agents DROP COLUMN IF EXISTS current_message_id;
