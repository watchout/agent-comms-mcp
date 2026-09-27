BEGIN;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '30000ms';
LOCK TABLE aun_configuration_desired_outbox IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM aun_configuration_desired_outbox WHERE superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'CONFIGURATION_SUPERSESSION_HISTORY_MUST_BE_PRESERVED';
  END IF;
END $$;
DROP INDEX IF EXISTS idx_aun_configuration_outbox_unsettled;
ALTER TABLE aun_configuration_desired_outbox
  DROP CONSTRAINT IF EXISTS aun_configuration_outbox_supersession_valid,
  DROP COLUMN superseded_at,
  DROP COLUMN superseded_by_revision,
  DROP COLUMN superseded_by_digest;
COMMIT;
