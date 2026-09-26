BEGIN;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '30000ms';

DO $$ BEGIN
  IF to_regclass('aun_configuration_desired_outbox') IS NULL THEN RETURN; END IF;
ALTER TABLE aun_configuration_desired_outbox
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_revision BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_by_digest TEXT;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='aun_configuration_desired_outbox'::regclass
      AND conname='aun_configuration_outbox_supersession_valid') THEN
    ALTER TABLE aun_configuration_desired_outbox ADD CONSTRAINT aun_configuration_outbox_supersession_valid
      CHECK ((superseded_at IS NULL AND superseded_by_revision IS NULL AND superseded_by_digest IS NULL)
        OR (superseded_at IS NOT NULL AND delivered_at IS NULL
          AND superseded_by_revision IS NOT NULL AND superseded_by_revision > desired_revision
          AND superseded_by_digest IS NOT NULL AND superseded_by_digest ~ '^[0-9a-f]{64}$'));
  END IF;

CREATE INDEX IF NOT EXISTS idx_aun_configuration_outbox_unsettled
  ON aun_configuration_desired_outbox(agent_id, desired_revision DESC)
  WHERE delivered_at IS NULL AND superseded_at IS NULL;
END $$;
COMMIT;
