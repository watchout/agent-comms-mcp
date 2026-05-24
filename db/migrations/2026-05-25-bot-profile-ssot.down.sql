DROP INDEX IF EXISTS idx_agents_profile_enabled;
DROP INDEX IF EXISTS idx_agents_home_directory;

ALTER TABLE agents DROP COLUMN IF EXISTS profile_updated_at;
ALTER TABLE agents DROP COLUMN IF EXISTS profile_source;
ALTER TABLE agents DROP COLUMN IF EXISTS profile_revision;
ALTER TABLE agents DROP COLUMN IF EXISTS profile_enabled;
ALTER TABLE agents DROP COLUMN IF EXISTS expected_provider_identity;
ALTER TABLE agents DROP COLUMN IF EXISTS provider_token_source_ref;
ALTER TABLE agents DROP COLUMN IF EXISTS runtime_engine_preference;
ALTER TABLE agents DROP COLUMN IF EXISTS home_directory;

CREATE OR REPLACE FUNCTION set_agent_identity_defaults()
RETURNS trigger AS $$
BEGIN
  IF NEW.agent_uri IS NULL OR NEW.agent_uri = '' THEN
    NEW.agent_uri := 'aun://' || COALESCE(NEW.org_id, 'default') || '/agents/' || NEW.agent_id;
  END IF;
  IF NEW.identity_scope IS NULL OR NEW.identity_scope = '' THEN
    NEW.identity_scope := 'local';
  END IF;
  IF NEW.trust_status IS NULL OR NEW.trust_status = '' THEN
    NEW.trust_status := 'local';
  END IF;
  IF NEW.auth_method IS NULL OR NEW.auth_method = '' THEN
    NEW.auth_method := 'local';
  END IF;
  IF NEW.identity_metadata IS NULL THEN
    NEW.identity_metadata := '{}'::jsonb;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agents_identity_defaults ON agents;
CREATE TRIGGER trg_agents_identity_defaults
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW
  EXECUTE FUNCTION set_agent_identity_defaults();
