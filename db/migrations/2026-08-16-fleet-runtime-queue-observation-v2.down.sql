BEGIN;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '30000ms';

LOCK TABLE message_queue IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS fleet_runtime_queue_agent_revision_v2 ON message_queue;
DROP FUNCTION IF EXISTS fleet_runtime_bump_queue_agent_revision_v2();
DROP TABLE IF EXISTS fleet_runtime_queue_agent_revisions;
DROP TABLE IF EXISTS fleet_runtime_queue_observation_active;

DO $verify$
BEGIN
  IF to_regclass('fleet_runtime_queue_observation_epoch_seq') IS NULL
    OR to_regclass('fleet_runtime_queue_agent_revisions') IS NOT NULL
    OR to_regclass('fleet_runtime_queue_observation_active') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'fleet_runtime_queue_agent_revision_v2' AND NOT tgisinternal
    )
    OR to_regprocedure('fleet_runtime_bump_queue_agent_revision_v2()') IS NOT NULL THEN
    RAISE EXCEPTION 'fleet-runtime queue observation v2 down readback failed';
  END IF;
END;
$verify$;

COMMIT;
