DROP TABLE IF EXISTS agent_identity_keys;
DROP TABLE IF EXISTS agent_endpoints;
DROP TABLE IF EXISTS agent_runtime_instances;
DROP TABLE IF EXISTS agent_workspace_bindings;
DROP TABLE IF EXISTS agent_workspaces;

DROP INDEX IF EXISTS idx_agents_trust_status;
DROP INDEX IF EXISTS idx_agents_identity_scope;
DROP INDEX IF EXISTS idx_agents_agent_uri;

DO $$ BEGIN
  DROP TRIGGER IF EXISTS trg_agents_identity_defaults ON agents;
  DROP FUNCTION IF EXISTS set_agent_identity_defaults();
  ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_auth_method_check;
  ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_trust_status_check;
  ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_identity_scope_check;
END $$;

ALTER TABLE agents DROP COLUMN IF EXISTS identity_metadata;
ALTER TABLE agents DROP COLUMN IF EXISTS disabled_at;
ALTER TABLE agents DROP COLUMN IF EXISTS auth_subject;
ALTER TABLE agents DROP COLUMN IF EXISTS auth_method;
ALTER TABLE agents DROP COLUMN IF EXISTS trust_status;
ALTER TABLE agents DROP COLUMN IF EXISTS identity_scope;
ALTER TABLE agents DROP COLUMN IF EXISTS agent_uri;
