BEGIN;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '30000ms';

LOCK TABLE message_queue IN SHARE ROW EXCLUSIVE MODE;

CREATE SEQUENCE IF NOT EXISTS fleet_runtime_queue_observation_epoch_seq AS bigint;

CREATE TABLE IF NOT EXISTS fleet_runtime_queue_observation_active (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version text NOT NULL CHECK (schema_version = 'fleet-runtime-v1/observation/v2'),
  contract_revision integer NOT NULL CHECK (contract_revision = 2),
  migration_epoch bigint NOT NULL CHECK (migration_epoch > 0),
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO fleet_runtime_queue_observation_active (
  singleton,
  schema_version,
  contract_revision,
  migration_epoch
)
VALUES (
  true,
  'fleet-runtime-v1/observation/v2',
  2,
  nextval('fleet_runtime_queue_observation_epoch_seq')
)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS fleet_runtime_queue_agent_revisions (
  migration_epoch bigint NOT NULL,
  agent_id text NOT NULL CHECK (agent_id <> '' AND agent_id = btrim(agent_id)),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (migration_epoch, agent_id)
);

INSERT INTO fleet_runtime_queue_agent_revisions (migration_epoch, agent_id, revision)
SELECT active.migration_epoch, initial_agents.agent_id, 0
  FROM fleet_runtime_queue_observation_active active
 CROSS JOIN (
   SELECT agent_id
     FROM agents
    WHERE profile_enabled = true
      AND disabled_at IS NULL
      AND status <> 'disabled'
      AND agent_id IS NOT NULL
      AND agent_id <> ''
   UNION
   SELECT agent_id
     FROM message_queue
    WHERE agent_id IS NOT NULL
      AND agent_id <> ''
 ) AS initial_agents
 WHERE active.singleton = true
 ORDER BY initial_agents.agent_id
ON CONFLICT (migration_epoch, agent_id) DO NOTHING;

CREATE OR REPLACE FUNCTION fleet_runtime_bump_queue_agent_revision_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  active_epoch bigint;
  affected_agent_id text;
BEGIN
  SELECT migration_epoch
    INTO STRICT active_epoch
    FROM fleet_runtime_queue_observation_active
   WHERE singleton = true
     AND schema_version = 'fleet-runtime-v1/observation/v2'
     AND contract_revision = 2;

  FOR affected_agent_id IN
    SELECT DISTINCT agent_id
      FROM (VALUES (
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.agent_id ELSE NULL END
      ), (
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.agent_id ELSE NULL END
      )) AS affected(agent_id)
     WHERE agent_id IS NOT NULL
       AND agent_id <> ''
  LOOP
    INSERT INTO fleet_runtime_queue_agent_revisions (
      migration_epoch,
      agent_id,
      revision,
      updated_at
    )
    VALUES (active_epoch, affected_agent_id, 1, transaction_timestamp())
    ON CONFLICT (migration_epoch, agent_id) DO UPDATE
      SET revision = fleet_runtime_queue_agent_revisions.revision + 1,
          updated_at = transaction_timestamp();
  END LOOP;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS fleet_runtime_queue_agent_revision_v2 ON message_queue;
CREATE TRIGGER fleet_runtime_queue_agent_revision_v2
AFTER INSERT OR UPDATE OR DELETE ON message_queue
FOR EACH ROW
EXECUTE FUNCTION fleet_runtime_bump_queue_agent_revision_v2();

DO $verify$
DECLARE
  marker_count integer;
  trigger_count integer;
  missing_bootstrap_count integer;
BEGIN
  SELECT count(*) INTO marker_count
    FROM fleet_runtime_queue_observation_active
   WHERE singleton = true
     AND schema_version = 'fleet-runtime-v1/observation/v2'
     AND contract_revision = 2
     AND migration_epoch > 0;
  SELECT count(*) INTO trigger_count
    FROM pg_trigger
   WHERE tgrelid = 'message_queue'::regclass
     AND tgname = 'fleet_runtime_queue_agent_revision_v2'
     AND NOT tgisinternal;
  SELECT count(*) INTO missing_bootstrap_count
    FROM (
      SELECT agent_id
        FROM agents
       WHERE profile_enabled = true AND disabled_at IS NULL AND status <> 'disabled'
         AND agent_id IS NOT NULL AND agent_id <> ''
      UNION
      SELECT agent_id FROM message_queue WHERE agent_id IS NOT NULL AND agent_id <> ''
    ) expected
   WHERE NOT EXISTS (
     SELECT 1
       FROM fleet_runtime_queue_agent_revisions revisions
       JOIN fleet_runtime_queue_observation_active active
         ON active.migration_epoch = revisions.migration_epoch
      WHERE active.singleton = true AND revisions.agent_id = expected.agent_id
   );
  IF marker_count <> 1 OR trigger_count <> 1 OR missing_bootstrap_count <> 0 THEN
    RAISE EXCEPTION 'fleet-runtime queue observation v2 exact readback failed';
  END IF;
END;
$verify$;

COMMIT;
