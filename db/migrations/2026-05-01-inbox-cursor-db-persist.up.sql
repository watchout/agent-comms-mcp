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

-- C: one-shot cleanup — drain the pre-fix snapshot.
-- Two paths:
--   (1) Stale 'read' rows with expired claims → reclaim to 'pending' (the new
--       session will re-pop them via `next`).
--   (2) PR-0 §4 case 4 verbatim — `agent_messages` で discord 受信から 24h
--       以上経過した stale pending 相当 = `message_queue` row が 24h+ pending
--       のままの履歴 (lead-ama / cto / agent-com-dev session が drain しなかっ
--       た queue 残骸) を `status='read'`, `read_at=created_at` に flip。
--       実態的には 50-200 行想定 (本日 chain stall の沈殿)。
UPDATE message_queue
SET status = 'pending',
    claimed_by = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    read_at = NULL
WHERE status = 'read'
  AND claim_expires_at IS NOT NULL
  AND claim_expires_at < now() - interval '15 minutes';

UPDATE message_queue
SET status = 'read',
    read_at = COALESCE(read_at, created_at)
WHERE status = 'pending'
  AND created_at < now() - interval '24 hours';
