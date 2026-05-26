CREATE TABLE IF NOT EXISTS connector_credentials (
  credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'discord',
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
  credential_kind TEXT NOT NULL DEFAULT 'bot_token',
  secret_ref TEXT NOT NULL,
  token_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'registered',
  trust_status TEXT NOT NULL DEFAULT 'local',
  source TEXT NOT NULL DEFAULT 'bot_profile_projector',
  evidence_revision INTEGER NOT NULL DEFAULT 1,
  last_verified_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE connector_credentials ADD CONSTRAINT connector_credentials_status_check
    CHECK (status IN ('registered', 'active', 'disabled', 'rotated', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE connector_credentials ADD CONSTRAINT connector_credentials_trust_status_check
    CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_credentials_provider_secret_ref_live
  ON connector_credentials(provider, secret_ref)
  WHERE status IN ('registered', 'active');
CREATE INDEX IF NOT EXISTS idx_connector_credentials_agent_status
  ON connector_credentials(agent_id, provider, status);
CREATE INDEX IF NOT EXISTS idx_connector_credentials_connector
  ON connector_credentials(connector_instance_id)
  WHERE connector_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_provider_identities (
  provider_identity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'discord',
  provider_subject_id TEXT NOT NULL,
  provider_handle TEXT,
  identity_kind TEXT NOT NULL DEFAULT 'bot',
  status TEXT NOT NULL DEFAULT 'expected',
  trust_status TEXT NOT NULL DEFAULT 'unverified',
  source TEXT NOT NULL DEFAULT 'bot_profile_projector',
  evidence_revision INTEGER NOT NULL DEFAULT 1,
  last_verified_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE agent_provider_identities ADD CONSTRAINT agent_provider_identities_status_check
    CHECK (status IN ('expected', 'verified', 'disabled', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agent_provider_identities ADD CONSTRAINT agent_provider_identities_trust_status_check
    CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_provider_identities_provider_subject_live
  ON agent_provider_identities(provider, provider_subject_id)
  WHERE status IN ('expected', 'verified');
CREATE INDEX IF NOT EXISTS idx_agent_provider_identities_agent_provider
  ON agent_provider_identities(agent_id, provider, status);

CREATE TABLE IF NOT EXISTS provider_channel_access (
  provider_channel_access_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'discord',
  provider_channel_id TEXT NOT NULL,
  connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(agent_id) ON DELETE CASCADE,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  trust_status TEXT NOT NULL DEFAULT 'local',
  source TEXT NOT NULL DEFAULT 'provider_discovery',
  discovered_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE provider_channel_access ADD CONSTRAINT provider_channel_access_status_check
    CHECK (status IN ('active', 'stale', 'disabled', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE provider_channel_access ADD CONSTRAINT provider_channel_access_trust_status_check
    CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_channel_access_connector_channel_live
  ON provider_channel_access(provider, provider_channel_id, connector_instance_id)
  WHERE status = 'active' AND connector_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_channel_access_agent
  ON provider_channel_access(agent_id, provider, status)
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_channel_access_channel
  ON provider_channel_access(provider, provider_channel_id, status);

CREATE TABLE IF NOT EXISTS agent_ui_bindings (
  binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  ui_type TEXT NOT NULL DEFAULT 'discord',
  ui_id TEXT NOT NULL,
  ui_handle TEXT,
  ui_token_ref TEXT,
  ui_token_fingerprint TEXT,
  connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
  credential_id UUID REFERENCES connector_credentials(credential_id) ON DELETE SET NULL,
  provider_identity_id UUID REFERENCES agent_provider_identities(provider_identity_id) ON DELETE SET NULL,
  surface_role TEXT NOT NULL DEFAULT 'primary',
  status TEXT NOT NULL DEFAULT 'registered',
  trust_status TEXT NOT NULL DEFAULT 'unverified',
  last_verified_at TIMESTAMPTZ,
  evidence_revision INTEGER NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE agent_ui_bindings ADD CONSTRAINT agent_ui_bindings_status_check
    CHECK (status IN ('registered', 'active', 'disabled', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agent_ui_bindings ADD CONSTRAINT agent_ui_bindings_trust_status_check
    CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_ui_bindings_ui_live
  ON agent_ui_bindings(ui_type, ui_id)
  WHERE status IN ('registered', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_ui_bindings_agent_role_live
  ON agent_ui_bindings(agent_id, ui_type, surface_role)
  WHERE status IN ('registered', 'active');
CREATE INDEX IF NOT EXISTS idx_agent_ui_bindings_connector
  ON agent_ui_bindings(connector_instance_id)
  WHERE connector_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_ui_bindings_credential
  ON agent_ui_bindings(credential_id)
  WHERE credential_id IS NOT NULL;
