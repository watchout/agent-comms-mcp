CREATE TABLE IF NOT EXISTS channel_routing_policy (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  primary_agent_id TEXT REFERENCES agents(agent_id),
  adapter_owner_agent_id TEXT REFERENCES agents(agent_id),
  outbound_allowlist JSONB,
  native_role_outbound_owners JSONB NOT NULL DEFAULT '{}'::jsonb,
  native_projection_identities JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_source TEXT NOT NULL DEFAULT 'db',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_routing_policy_primary
  ON channel_routing_policy(primary_agent_id)
  WHERE primary_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_routing_policy_adapter_owner
  ON channel_routing_policy(adapter_owner_agent_id)
  WHERE adapter_owner_agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS role_routing (
  role_key TEXT PRIMARY KEY,
  channel_id TEXT REFERENCES channels(id),
  agent_id TEXT REFERENCES agents(agent_id),
  description TEXT,
  new_work_allowed BOOLEAN NOT NULL DEFAULT true,
  policy_source TEXT NOT NULL DEFAULT 'db',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_role_routing_agent
  ON role_routing(agent_id)
  WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_aliases (
  alias TEXT PRIMARY KEY,
  canonical_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  new_work_allowed BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
