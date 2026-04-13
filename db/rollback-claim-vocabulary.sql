-- FEAT-005 CP-3 DOWN migration: revert 'claimed' → 'processing'.
--
-- Symmetric to the forward migration in db/migrate.ts (installed
-- 2026-04-14, commit feat/adapter-rewrite-feat-005). Apply manually
-- when a rollback is needed:
--
--   psql "$DATABASE_URL" -f db/rollback-claim-vocabulary.sql
--
-- Forward-only reversal. Safe against rows inserted after the rename
-- because they can only exist in the new vocabulary (all 'claimed' or
-- pending/sent/failed).

BEGIN;

DO $$
BEGIN
  -- 1. Drop the post-CP-3 CHECK.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'outbound_queue'::regclass
       AND conname  = 'outbound_queue_status_check'
  ) THEN
    ALTER TABLE outbound_queue DROP CONSTRAINT outbound_queue_status_check;
  END IF;

  -- 2. Revert the vocabulary on in-flight rows.
  UPDATE outbound_queue SET status = 'processing' WHERE status = 'claimed';

  -- 3. Re-install the pre-FEAT-005 CHECK.
  ALTER TABLE outbound_queue
    ADD CONSTRAINT outbound_queue_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'failed'));
END $$;

-- 4. Partial-index WHERE predicate reverts.
DROP INDEX IF EXISTS idx_outbound_queue_claimed_claimed_at;
CREATE INDEX IF NOT EXISTS idx_outbound_queue_processing_claimed_at
  ON outbound_queue(status, claimed_at)
  WHERE status = 'processing';

COMMIT;
