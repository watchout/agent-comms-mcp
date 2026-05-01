-- Issue #287 — DB-persisted inbox cursor + self-reclaim of orphaned claims.
-- Idempotent up migration. Mirrors the inline ALTER block in db/migrate.ts so
-- operators can run `bun db/migrate.ts --down=2026-05-01-inbox-cursor-db-persist`
-- to roll back without editing the source file.

DO $$ BEGIN
  -- A: cursor persistence — surviving session restart
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS inbox_cursor_at TIMESTAMPTZ;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS inbox_cursor_id UUID;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- C: one-shot cleanup — claims orphaned past their TTL get reclaimed back to
-- 'pending' so the next session-restart receives them. We do NOT flip them to
-- 'failed' here (claim-ttl-sweeper still owns that path with its longer TTL);
-- this is the pre-fix snapshot drain.
UPDATE message_queue
SET status = 'pending',
    claimed_by = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    read_at = NULL
WHERE status = 'read'
  AND claim_expires_at IS NOT NULL
  AND claim_expires_at < now() - interval '15 minutes';
