-- History is evidence. Ordinary rollback may remove only an unused schema;
-- accepted/candidate/revoked manifest rows must be preserved for read-back.
DO $$
DECLARE
  table_name TEXT;
  has_history BOOLEAN;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'all_agent_communication_manifest_revisions',
    'all_agent_communication_manifest_targets',
    'all_agent_communication_manifest_projections'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)', table_name)
        INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION 'refusing all-agent manifest down migration: durable manifest history is not empty';
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS all_agent_communication_manifest_projections;
DROP TABLE IF EXISTS all_agent_communication_manifest_targets;
DROP TABLE IF EXISTS all_agent_communication_manifest_revisions;
