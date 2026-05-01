-- Issue #287 — reversal of inbox cursor DB persistence.
-- Drops the cursor columns from agents. The one-shot pending re-flip from the
-- up migration is NOT reversed (it was a snapshot cleanup; rolling it back
-- would re-orphan rows). Idempotent: each statement guarded with IF EXISTS.

DO $$ BEGIN
  ALTER TABLE agents DROP COLUMN IF EXISTS inbox_cursor_id;
  ALTER TABLE agents DROP COLUMN IF EXISTS inbox_cursor_at;
END $$;
