-- PR #338 sub-PR 1 rollback: restore the v0.8 status enum + failed_reason
-- column from the v0.9 state.
--
-- Operator-initiated only. Applied via db/migrate.ts applyDownMigration,
-- which routes statements through gatedQuery — destructive statements
-- need AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1 set in the env to
-- proceed (production launchd plist only). incident #339 anchor.
--
-- Rollback contract per spec §1.1b: Phase 1 + 2 のみ実行で stop 可能。
-- Phase 3 verify 失敗時の旧 row 復元は best-effort because the 3-way
-- branch on `failed` rows loses the original distinction once the rows
-- have been mapped to `pending` or `replied`. The audit_log preserves
-- the original status + reason for PERMANENT / skipped rows; the rest
-- are restored to a safe terminal close as `failed` (PERMANENT) so the
-- legacy code path sees the row in the legacy vocabulary.
--
-- Steps (reverse order of up.sql):
--   1. Re-add failed_reason column (idempotent)
--   2. Swap CHECK constraint back to the v0.8 5 values
--   3. Restore status from audit_log entries written by up.sql
--   4. Leave audit_log table in place (operator may DROP manually after
--      rollback verification; preserving it lets operators reconstruct
--      the migration history)

BEGIN;

-- 1. Re-add failed_reason column.
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT;

-- 2. CHECK constraint swap back to v0.8 values (pending|read|replied|skipped|failed).
--    Need to migrate any rows in the v0.9-only states (received|in_progress|done)
--    *before* the ADD CONSTRAINT validates them, since the legacy vocabulary
--    does not include those literals.
UPDATE message_queue SET status = 'read'    WHERE status = 'received';
UPDATE message_queue SET status = 'read'    WHERE status = 'in_progress';
UPDATE message_queue SET status = 'replied' WHERE status = 'done';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'message_queue_status_check'
       AND conrelid = 'message_queue'::regclass
  ) THEN
    ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;
  END IF;

  ALTER TABLE message_queue
    ADD CONSTRAINT message_queue_status_check
    CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed'));
END $$;

-- 3. Restore PERMANENT failure rows from audit_log. The up.sql transformed
--    every PERMANENT failure into status='replied'; we cannot tell those
--    apart from genuine v0.9 'done'/'replied' rows post-up. We therefore
--    walk audit_log (original_status='failed') and reset matching queue_id
--    rows to status='failed' + restore the captured reason.
UPDATE message_queue mq
   SET status = 'failed',
       failed_reason = a.original_reason
  FROM (
    SELECT DISTINCT ON (queue_id) queue_id, original_reason
      FROM audit_log
     WHERE original_status = 'failed'
     ORDER BY queue_id, archived_at DESC
  ) a
 WHERE mq.id = a.queue_id;

-- skipped row 復元: audit_log の original_status='skipped' を逆転。
-- up.sql で status='replied' に置いたので、id が audit_log に居れば
-- status='skipped' に戻す。
UPDATE message_queue mq
   SET status = 'skipped',
       failed_reason = a.original_reason
  FROM (
    SELECT DISTINCT ON (queue_id) queue_id, original_reason
      FROM audit_log
     WHERE original_status = 'skipped'
     ORDER BY queue_id, archived_at DESC
  ) a
 WHERE mq.id = a.queue_id;

-- done_at column は v0.8 schema 不在、DROP。
ALTER TABLE message_queue DROP COLUMN IF EXISTS done_at;

COMMIT;

-- audit_log table はそのまま保持。operator が rollback 検証後に手動 DROP
-- 可。これにより 2 回目以降の rollback で同 row が二重復元されるのを
-- 防ぐ。
