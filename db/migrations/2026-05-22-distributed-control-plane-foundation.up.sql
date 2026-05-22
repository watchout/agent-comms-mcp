CREATE TABLE IF NOT EXISTS connector_instances (
  connector_instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'discord',
  connector_kind TEXT NOT NULL DEFAULT 'chat_adapter',
  transport TEXT NOT NULL DEFAULT 'discord_gateway',
  connector_uri TEXT,
  status TEXT NOT NULL DEFAULT 'registered',
  trust_status TEXT NOT NULL DEFAULT 'local',
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE connector_instances ADD CONSTRAINT connector_instances_status_check
    CHECK (status IN ('registered', 'active', 'standby', 'draining', 'stopped', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE connector_instances ADD CONSTRAINT connector_instances_trust_status_check
    CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_connector_instances_agent_status
  ON connector_instances(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_connector_instances_runtime
  ON connector_instances(runtime_instance_id)
  WHERE runtime_instance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_instances_provider_uri
  ON connector_instances(provider, connector_uri)
  WHERE connector_uri IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_connector_bindings (
  channel_binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'discord',
  connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
  binding_role TEXT NOT NULL DEFAULT 'outbound',
  priority INTEGER NOT NULL DEFAULT 100,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  ordering_scope TEXT NOT NULL DEFAULT 'thread',
  status TEXT NOT NULL DEFAULT 'active',
  policy_source TEXT NOT NULL DEFAULT 'db',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE channel_connector_bindings ADD CONSTRAINT channel_connector_bindings_role_check
    CHECK (binding_role IN ('inbound', 'outbound', 'bidirectional', 'projection', 'presence', 'worker'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE channel_connector_bindings ADD CONSTRAINT channel_connector_bindings_ordering_check
    CHECK (ordering_scope IN ('none', 'channel', 'thread', 'custom'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE channel_connector_bindings ADD CONSTRAINT channel_connector_bindings_status_check
    CHECK (status IN ('active', 'standby', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_channel_connector_bindings_channel
  ON channel_connector_bindings(channel_id, provider, binding_role, status);
CREATE INDEX IF NOT EXISTS idx_channel_connector_bindings_connector
  ON channel_connector_bindings(connector_instance_id)
  WHERE connector_instance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connector_bindings_active_unique
  ON channel_connector_bindings(channel_id, provider, binding_role, connector_instance_id)
  WHERE status = 'active' AND connector_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS control_plane_leases (
  lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_scope_type TEXT NOT NULL,
  lease_scope_id TEXT NOT NULL,
  lease_purpose TEXT NOT NULL DEFAULT 'worker',
  holder_agent_id TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
  holder_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
  holder_connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
  fencing_token BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  acquired_at TIMESTAMPTZ DEFAULT now(),
  heartbeat_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$ BEGIN
  ALTER TABLE control_plane_leases ADD CONSTRAINT control_plane_leases_scope_check
    CHECK (lease_scope_type IN ('connector_instance', 'channel_binding', 'queue_partition', 'runtime_instance'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE control_plane_leases ADD CONSTRAINT control_plane_leases_purpose_check
    CHECK (lease_purpose IN ('inbound', 'outbound', 'worker', 'leader', 'presence', 'maintenance'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE control_plane_leases ADD CONSTRAINT control_plane_leases_status_check
    CHECK (status IN ('active', 'released', 'expired', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_plane_leases_active_scope
  ON control_plane_leases(lease_scope_type, lease_scope_id, lease_purpose)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_control_plane_leases_expiry
  ON control_plane_leases(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_control_plane_leases_holder_runtime
  ON control_plane_leases(holder_runtime_instance_id)
  WHERE holder_runtime_instance_id IS NOT NULL;

ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS assigned_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL;
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL;
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS channel_binding_id UUID REFERENCES channel_connector_bindings(channel_binding_id) ON DELETE SET NULL;
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS ordering_key TEXT;

CREATE INDEX IF NOT EXISTS idx_mq_assigned_runtime
  ON message_queue(assigned_runtime_instance_id, status, priority DESC, created_at ASC)
  WHERE assigned_runtime_instance_id IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mq_channel_binding_ordering
  ON message_queue(channel_binding_id, ordering_key, status, created_at ASC)
  WHERE channel_binding_id IS NOT NULL;

ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS delivery_connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL;
ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS channel_binding_id UUID REFERENCES channel_connector_bindings(channel_binding_id) ON DELETE SET NULL;
ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS claimed_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_queue_delivery_connector_pending
  ON outbound_queue(delivery_connector_instance_id, status, next_retry_at)
  WHERE delivery_connector_instance_id IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbound_queue_channel_binding_pending
  ON outbound_queue(channel_binding_id, status, next_retry_at)
  WHERE channel_binding_id IS NOT NULL AND status = 'pending';
