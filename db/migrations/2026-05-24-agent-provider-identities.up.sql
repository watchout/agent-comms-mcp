CREATE TABLE IF NOT EXISTS agent_provider_identities (
  provider_identity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'discord',
  provider_subject_id TEXT NOT NULL,
  identity_kind TEXT NOT NULL DEFAULT 'bot_user',
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  trust_status TEXT NOT NULL DEFAULT 'local',
  connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  UNIQUE(agent_id, provider, identity_kind),
  UNIQUE(provider, provider_subject_id)
);

DO $$ BEGIN
  ALTER TABLE agent_provider_identities ADD CONSTRAINT agent_provider_identities_kind_check
    CHECK (identity_kind IN ('bot_user', 'human_user', 'webhook', 'app', 'service_account', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agent_provider_identities ADD CONSTRAINT agent_provider_identities_status_check
    CHECK (status IN ('active', 'disabled', 'revoked', 'stale'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agent_provider_identities ADD CONSTRAINT agent_provider_identities_trust_status_check
    CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_provider_identities_agent
  ON agent_provider_identities(agent_id, provider, status);

CREATE INDEX IF NOT EXISTS idx_agent_provider_identities_connector
  ON agent_provider_identities(connector_instance_id)
  WHERE connector_instance_id IS NOT NULL;

INSERT INTO agent_provider_identities (
  agent_id, provider, provider_subject_id, identity_kind, display_name,
  status, trust_status, metadata
)
SELECT agent_id,
       'discord',
       metadata->>'discord_id',
       CASE WHEN agent_type = 'human' THEN 'human_user' ELSE 'bot_user' END,
       display_name,
       'active',
       COALESCE(NULLIF(trust_status, ''), 'local'),
       jsonb_build_object('source', 'agents.metadata.discord_id_backfill')
  FROM agents
 WHERE metadata->>'discord_id' IS NOT NULL
   AND metadata->>'discord_id' <> ''
ON CONFLICT (agent_id, provider, identity_kind) DO UPDATE SET
  provider_subject_id = EXCLUDED.provider_subject_id,
  display_name = EXCLUDED.display_name,
  status = CASE
             WHEN agent_provider_identities.status IN ('disabled', 'revoked')
               THEN agent_provider_identities.status
             ELSE 'active'
           END,
  trust_status = CASE
                   WHEN agent_provider_identities.trust_status IN ('disabled', 'revoked')
                     THEN agent_provider_identities.trust_status
                   ELSE EXCLUDED.trust_status
                 END,
  last_seen_at = now(),
  updated_at = now(),
  metadata = COALESCE(agent_provider_identities.metadata, '{}'::jsonb)
          || jsonb_build_object('source', 'agents.metadata.discord_id_backfill');
