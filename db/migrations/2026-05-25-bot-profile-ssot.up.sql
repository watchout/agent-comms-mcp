ALTER TABLE agents ADD COLUMN IF NOT EXISTS home_directory TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_engine_preference TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider_token_source_ref TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS expected_provider_identity JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;

UPDATE agents
   SET expected_provider_identity = '{}'::jsonb
 WHERE expected_provider_identity IS NULL;

UPDATE agents
   SET profile_enabled = true
 WHERE profile_enabled IS NULL;

UPDATE agents
   SET profile_revision = 1
 WHERE profile_revision IS NULL OR profile_revision < 1;

UPDATE agents
   SET profile_source = 'legacy'
 WHERE profile_source IS NULL OR profile_source = '';

CREATE INDEX IF NOT EXISTS idx_agents_home_directory
  ON agents(org_id, home_directory)
  WHERE home_directory IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agents_profile_enabled
  ON agents(profile_enabled);

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
  IF NEW.expected_provider_identity IS NULL THEN
    NEW.expected_provider_identity := '{}'::jsonb;
  END IF;
  IF NEW.profile_enabled IS NULL THEN
    NEW.profile_enabled := true;
  END IF;
  IF NEW.profile_revision IS NULL OR NEW.profile_revision < 1 THEN
    NEW.profile_revision := 1;
  END IF;
  IF NEW.profile_source IS NULL OR NEW.profile_source = '' THEN
    NEW.profile_source := 'legacy';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agents_identity_defaults ON agents;
CREATE TRIGGER trg_agents_identity_defaults
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW
  EXECUTE FUNCTION set_agent_identity_defaults();
