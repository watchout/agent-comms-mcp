-- D-CFG-1: logical restart governance survives the observation cutover.
-- host_id removal is explicitly adopted; retain all request IDs and other history.
BEGIN;
DO $$
BEGIN
  IF to_regclass('aun_configuration_restart_requests') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM aun_configuration_restart_requests
    GROUP BY agent_id,to_revision,to_digest HAVING count(*)>1) THEN
    RAISE EXCEPTION 'AUN_CONFIGURATION_LOGICAL_RESTART_CONFLICT';
  END IF;
  ALTER TABLE aun_configuration_restart_requests DROP COLUMN IF EXISTS host_id;
  ALTER TABLE aun_configuration_restart_requests ADD COLUMN IF NOT EXISTS rollback_release_commit TEXT;
  ALTER TABLE aun_configuration_restart_requests ADD COLUMN IF NOT EXISTS rollback_release_tree TEXT;
  ALTER TABLE aun_configuration_restart_requests ALTER COLUMN candidate_digest DROP NOT NULL;
  ALTER TABLE aun_configuration_restart_requests ALTER COLUMN rollback_artifact_digest DROP NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS aun_configuration_restart_logical_unique
    ON aun_configuration_restart_requests(agent_id,to_revision,to_digest);
  DROP TRIGGER IF EXISTS zz_aun_runtime_nonpersistence ON aun_configuration_restart_requests;
  CREATE TRIGGER zz_aun_runtime_nonpersistence AFTER INSERT OR UPDATE ON aun_configuration_restart_requests
    FOR EACH ROW EXECUTE FUNCTION aun_guard_runtime_nonpersistence(
      '{"physical":["host_id","candidate_digest","rollback_artifact_digest"],"json":{},"values":{"rollback_release_commit":"sha1","rollback_release_tree":"sha1"}}');
END $$;
CREATE OR REPLACE FUNCTION aun_guard_configuration_restart_release()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND (NEW.rollback_release_commit IS NULL OR NEW.rollback_release_tree IS NULL) THEN
    RAISE EXCEPTION 'AUN_CONFIGURATION_ROLLBACK_RELEASE_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
DO $$
BEGIN
  IF to_regclass('aun_configuration_restart_requests') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS zz_aun_configuration_restart_release ON aun_configuration_restart_requests;
    CREATE TRIGGER zz_aun_configuration_restart_release BEFORE INSERT ON aun_configuration_restart_requests
      FOR EACH ROW EXECUTE FUNCTION aun_guard_configuration_restart_release();
  END IF;
END $$;
COMMIT;
