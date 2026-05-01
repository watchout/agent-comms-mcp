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

-- C: one-shot cleanup — reclaim stale 'read' rows with expired claims so the
-- new session re-pops them via `next`. The 24h-pending → read flip block
-- previously here was removed in PR-0 cycle 6 (CTO judgment 2026-05-01,
-- auditor axis 3 BLOCK): silently flipping pending rows to `read` abandons
-- live backlog beyond the cursor-persistence scope. Stale-cleanup of long-
-- pending rows is tracked separately in Issue #294.
UPDATE message_queue
SET status = 'pending',
    claimed_by = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    read_at = NULL
WHERE status = 'read'
  AND claim_expires_at IS NOT NULL
  AND claim_expires_at < now() - interval '15 minutes';
