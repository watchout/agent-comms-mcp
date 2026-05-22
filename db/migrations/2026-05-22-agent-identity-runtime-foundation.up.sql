ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_uri TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS identity_scope TEXT NOT NULL DEFAULT 'local';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS trust_status TEXT NOT NULL DEFAULT 'local';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'local';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS auth_subject TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS identity_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE agents
   SET agent_uri = 'aun://' || COALESCE(org_id, 'default') || '/agents/' || agent_id
 WHERE agent_uri IS NULL OR agent_uri = '';

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

DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_identity_scope_check
    CHECK (identity_scope IN ('local', 'external', 'federated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_trust_status_check
    CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_auth_method_check
    CHECK (auth_method IN ('local', 'signed_key', 'mcp_token', 'oauth', 'none'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_uri
  ON agents(agent_uri)
  WHERE agent_uri IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_identity_scope ON agents(identity_scope);
CREATE INDEX IF NOT EXISTS idx_agents_trust_status ON agents(trust_status);

CREATE TABLE IF NOT EXISTS agent_workspaces (
  workspace_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  workspace_type TEXT NOT NULL DEFAULT 'local_path',
  local_path TEXT,
  repo_url TEXT,
  default_branch TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_workspaces_org ON agent_workspaces(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspaces_local_path
  ON agent_workspaces(org_id, local_path)
  WHERE local_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_workspace_bindings (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(workspace_id) ON DELETE CASCADE,
  binding_role TEXT NOT NULL DEFAULT 'primary',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (agent_id, workspace_id, binding_role)
);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_bindings_workspace
  ON agent_workspace_bindings(workspace_id)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS agent_runtime_instances (
  runtime_instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES agent_workspaces(workspace_id) ON DELETE SET NULL,
  runtime_engine TEXT NOT NULL DEFAULT 'unknown',
  runtime_kind TEXT NOT NULL DEFAULT 'local_process',
  host_id TEXT,
  session_name TEXT,
  process_id INTEGER,
  port INTEGER,
  checkout_path TEXT,
  commit_sha TEXT,
  endpoint_uri TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  started_at TIMESTAMPTZ DEFAULT now(),
  stopped_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_agent_runtime_instances_agent_status
  ON agent_runtime_instances(agent_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runtime_instances_workspace
  ON agent_runtime_instances(workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_endpoints (
  endpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  endpoint_uri TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'local',
  auth_method TEXT NOT NULL DEFAULT 'local',
  trust_status TEXT NOT NULL DEFAULT 'local',
  public_key_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  UNIQUE(agent_id, endpoint_uri)
);
CREATE INDEX IF NOT EXISTS idx_agent_endpoints_uri ON agent_endpoints(endpoint_uri);
CREATE INDEX IF NOT EXISTS idx_agent_endpoints_status ON agent_endpoints(status);

CREATE TABLE IF NOT EXISTS agent_identity_keys (
  key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  key_type TEXT NOT NULL DEFAULT 'ed25519',
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TIMESTAMPTZ DEFAULT now(),
  valid_until TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_identity_keys_agent_status
  ON agent_identity_keys(agent_id, status);
