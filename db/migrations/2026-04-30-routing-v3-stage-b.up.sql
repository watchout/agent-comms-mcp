-- Issue #278 (A) — routing v3 stage B per-row claim model.
-- Idempotent up migration. Mirrors the inline ALTER block in db/migrate.ts so
-- operators can run `bun db/migrate.ts --down=...` to roll back without
-- editing the source file.

DO $$ BEGIN
  ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_by TEXT;
  ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
  ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DROP INDEX IF EXISTS idx_mq_expired_claims;
CREATE INDEX IF NOT EXISTS idx_mq_expired_claims
  ON message_queue(claim_expires_at)
  WHERE claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL AND status = 'received';
