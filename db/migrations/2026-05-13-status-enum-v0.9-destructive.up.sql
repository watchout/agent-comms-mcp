-- PR #338 sub-PR 1: state-daemon v0.9 status enum destructive migration.
-- Spec: docs/spec/agentcom-state-daemon-v0.9-impl.md §1.1 + §1.1a + §1.1b.
--
-- Operator-initiated only. Applied via db/migrate.ts applyUpMigrationFile,
-- which routes every statement through gatedQuery so DROP COLUMN /
-- ALTER COLUMN / RENAME / TRUNCATE / DROP TABLE are blocked unless
-- AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1 is set in the environment
-- (production launchd plist only). incident #339 anchor.
--
-- Forward path (per spec §1.1b Phase 1-3, reordered so existing-row data
-- migration runs before the legacy values are forbidden by the CHECK
-- constraint — Postgres validates ADD CONSTRAINT against existing rows
-- unless NOT VALID is supplied, and the new value set does not include
-- the legacy literals):
--
--   1. message_queue_status_migration_audit table (idempotent CREATE)        -- §1.1a sink
--   2. message_queue.done_at column ADD            -- §1.1 schema
--   3. data migration (read→received, failed 3-way, skipped drop)
--   4. CHECK constraint swap (new 5 values)        -- §1.1 schema
--   5. message_queue.failed_reason column DROP     -- §1.1 schema (last)
--
-- Idempotent guards on every statement so a partial-replay during
-- operator action does not error.

BEGIN;

-- 1. message_queue_status_migration_audit table for §1.1a 3-way branch + §1.1b skipped drop sink.
--    Records the pre-migration status + reason so PERMANENT failures
--    and stray skipped rows are not silently lost.
CREATE TABLE IF NOT EXISTS message_queue_status_migration_audit (
  id              BIGSERIAL PRIMARY KEY,
  queue_id        BIGINT NOT NULL,
  original_status TEXT NOT NULL,
  original_reason TEXT,
  archived_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_queue_status_migration_audit_queue_id ON message_queue_status_migration_audit(queue_id);

-- 2. ADD done_at column (§1.1 schema). Idempotent.
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

-- 2b. Drop the existing CHECK constraint so the data migration in step 3
--     can write new-vocabulary values (received / in_progress / done) into
--     a table whose constraint still permits only the legacy 5. After
--     step 3 lands every row in the new vocabulary, step 4 re-installs
--     the constraint with the new-only value set.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'message_queue_status_check'
       AND conrelid = 'message_queue'::regclass
  ) THEN
    ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;
  END IF;
END $$;

-- 3. Data migration (§1.1b mapping). Runs with the CHECK constraint
--    temporarily absent so new vocabulary values do not violate the
--    legacy literal set mid-migration.
DO $$
DECLARE
  recent_implicit_abandon_window CONSTANT INTERVAL := '60 seconds';
BEGIN
  -- 3a. `failed` row 3-way branch (spec §1.1a literal):
  --
  --   (a) IMPLICIT_ABANDON + still within claim_expires_at window
  --         -> pending, no audit       (retry loop recovers; row stays alive)
  --
  --   (b) STALE_DISPATCH                          -> verify_bot_replied(row):
  --        - if the bot already replied to this row -> replied, no audit
  --          (verify_bot_replied = `replied_with IS NOT NULL` on the queue
  --          row OR an outbound agent_messages row from the same bot whose
  --          `reply_to` references this row's `message_id`; the universal
  --          agent_messages log is the SSOT for outbound bot replies, the
  --          queue's `replied_with` is the queue-side mirror set by the
  --          existing `send` path at server.ts:2392)
  --        - else                                  -> pending, no audit
  --          (operator follow-up; row alive, no terminal close)
  --
  --   (c) any other reason (PERMANENT / NULL / unknown)
  --         -> replied + audit         (terminal close; audit holds the
  --          pre-migration status + reason so rollback can restore)
  --
  -- Audit row is written *before* the UPDATE so a constraint failure on
  -- the UPDATE side rolls the audit back together inside the DO block
  -- transaction (the whole step 3 runs in the outer BEGIN at line 25).

  -- (c) PERMANENT audit. Includes everything not in (a) or (b).
  INSERT INTO message_queue_status_migration_audit (queue_id, original_status, original_reason, archived_at)
    SELECT id, 'failed', failed_reason, now()
      FROM message_queue
     WHERE status = 'failed'
       AND NOT (
         failed_reason = 'IMPLICIT_ABANDON'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at > now() - recent_implicit_abandon_window
       )
       AND failed_reason IS DISTINCT FROM 'STALE_DISPATCH';

  -- (a) IMPLICIT_ABANDON recent -> pending.
  UPDATE message_queue
     SET status = 'pending',
         failed_reason = NULL
   WHERE status = 'failed'
     AND failed_reason = 'IMPLICIT_ABANDON'
     AND claim_expires_at IS NOT NULL
     AND claim_expires_at > now() - recent_implicit_abandon_window;

  -- (b1) STALE_DISPATCH AND verify_bot_replied -> replied (spec §1.1a literal).
  UPDATE message_queue mq
     SET status = 'replied',
         failed_reason = NULL
   WHERE mq.status = 'failed'
     AND mq.failed_reason = 'STALE_DISPATCH'
     AND (
       mq.replied_with IS NOT NULL
       OR (
         mq.message_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM agent_messages am
            WHERE am.reply_to::text = mq.message_id
              AND am.author_id = mq.agent_id
              AND am.direction = 'outbound'
         )
       )
     );

  -- (b2) STALE_DISPATCH AND NOT verify_bot_replied -> pending (spec §1.1a literal).
  UPDATE message_queue
     SET status = 'pending',
         failed_reason = NULL
   WHERE status = 'failed'
     AND failed_reason = 'STALE_DISPATCH';

  -- (c) PERMANENT (anything `failed` still left after a/b) -> replied.
  UPDATE message_queue
     SET status = 'replied',
         failed_reason = NULL
   WHERE status = 'failed';

  -- 3b. `read` → `received` rename (§1.1b literal).
  UPDATE message_queue SET status = 'received' WHERE status = 'read';

  -- 3c. `skipped` drop (§1.1b literal:残あれば audit + replied 化).
  --     CC fanout 廃止で発生源 0 化済、本 migration 時点で残 row 0 件期待。
  --     残った場合は audit に記録した上で terminal close。
  INSERT INTO message_queue_status_migration_audit (queue_id, original_status, original_reason, archived_at)
    SELECT id, 'skipped', failed_reason, now()
      FROM message_queue
     WHERE status = 'skipped';

  UPDATE message_queue
     SET status = 'replied',
         failed_reason = NULL
   WHERE status = 'skipped';
END $$;

-- 4. ADD the new CHECK constraint (§1.1 schema). All rows are now in the
--    new vocabulary after step 3, so the validation pass succeeds.
ALTER TABLE message_queue
  ADD CONSTRAINT message_queue_status_check
  CHECK (status IN ('pending', 'received', 'in_progress', 'done', 'replied'));

-- 5. DROP failed_reason column last (§1.1 schema). After step 3 all
--    surviving rows have failed_reason = NULL and the message_queue_status_migration_audit holds
--    the only record of pre-migration reasons.
ALTER TABLE message_queue DROP COLUMN IF EXISTS failed_reason;

COMMIT;

-- Phase 3 verify (operator runs separately after COMMIT; included here as
-- a reference SELECT, not executed in this script):
--
--   SELECT count(*) FROM message_queue
--    WHERE status NOT IN ('pending','received','in_progress','done','replied');
--   -- expected: 0
