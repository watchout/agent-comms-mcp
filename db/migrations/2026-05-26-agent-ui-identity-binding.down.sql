DROP INDEX IF EXISTS uq_agents_ui_handle_active;
DROP INDEX IF EXISTS uq_agents_ui_id_active;

ALTER TABLE agents DROP COLUMN IF EXISTS ui_handle;
ALTER TABLE agents DROP COLUMN IF EXISTS ui_id;

DROP SEQUENCE IF EXISTS agent_ui_id_seq;

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
