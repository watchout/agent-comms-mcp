CREATE SEQUENCE IF NOT EXISTS agent_ui_id_seq;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS ui_id BIGINT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS ui_handle TEXT;

UPDATE agents
   SET ui_id = nextval('agent_ui_id_seq')
 WHERE ui_id IS NULL
   AND agent_type <> 'human'
   AND COALESCE(profile_enabled, true) = true;

SELECT setval(
  'agent_ui_id_seq',
  GREATEST((SELECT COALESCE(MAX(ui_id), 0) FROM agents), 1),
  (SELECT COALESCE(MAX(ui_id), 0) FROM agents) > 0
);

UPDATE agents
   SET ui_handle = COALESCE(NULLIF(metadata->>'replaces', ''), agent_id)
 WHERE (ui_handle IS NULL OR ui_handle = '')
   AND agent_type <> 'human'
   AND COALESCE(profile_enabled, true) = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_ui_id_active
  ON agents(ui_id)
  WHERE ui_id IS NOT NULL
    AND agent_type <> 'human'
    AND COALESCE(profile_enabled, true) = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_ui_handle_active
  ON agents(lower(ui_handle))
  WHERE ui_handle IS NOT NULL
    AND ui_handle <> ''
    AND agent_type <> 'human'
    AND COALESCE(profile_enabled, true) = true;

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
  IF NEW.agent_type <> 'human' AND COALESCE(NEW.profile_enabled, true) = true THEN
    IF NEW.ui_id IS NULL THEN
      NEW.ui_id := nextval('agent_ui_id_seq');
    END IF;
    IF NEW.ui_handle IS NULL OR NEW.ui_handle = '' THEN
      NEW.ui_handle := COALESCE(NULLIF(NEW.metadata->>'replaces', ''), NEW.agent_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agents_identity_defaults ON agents;
CREATE TRIGGER trg_agents_identity_defaults
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW
  EXECUTE FUNCTION set_agent_identity_defaults();
