ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS historical_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS new_work_allowed BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_agents_routable
  ON agents(agent_id)
  WHERE COALESCE(historical_only, false) = false
    AND COALESCE(new_work_allowed, true) = true
    AND COALESCE(profile_enabled, true) = true
    AND disabled_at IS NULL
    AND COALESCE(status, '') NOT IN ('disabled', 'retired');

ALTER TABLE role_routing
  ADD COLUMN IF NOT EXISTS active_function TEXT,
  ADD COLUMN IF NOT EXISTS canonical_seat TEXT,
  ADD COLUMN IF NOT EXISTS historical_only BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_role_routing_active_function
  ON role_routing(active_function, canonical_seat)
  WHERE COALESCE(historical_only, false) = false
    AND COALESCE(new_work_allowed, true) = true;

CREATE OR REPLACE FUNCTION aun_agent_is_routable(p_agent_id TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM agents a
     WHERE a.agent_id = p_agent_id
       AND COALESCE(a.historical_only, false) = false
       AND COALESCE(a.new_work_allowed, true) = true
       AND COALESCE(a.profile_enabled, true) = true
       AND a.disabled_at IS NULL
       AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION aun_assert_agent_routable(p_agent_id TEXT, p_context TEXT)
RETURNS VOID AS $$
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT aun_agent_is_routable(p_agent_id) THEN
    RAISE EXCEPTION 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_%: %', p_context, p_agent_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aun_enforce_connector_instance_routable()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('registered', 'active', 'standby', 'draining') THEN
    PERFORM aun_assert_agent_routable(NEW.agent_id, 'CONNECTOR');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aun_enforce_channel_binding_routable()
RETURNS trigger AS $$
DECLARE
  owner_agent_id TEXT;
BEGIN
  IF NEW.status IN ('active', 'standby') AND NEW.connector_instance_id IS NOT NULL THEN
    SELECT ci.agent_id INTO owner_agent_id
      FROM connector_instances ci
     WHERE ci.connector_instance_id = NEW.connector_instance_id;
    PERFORM aun_assert_agent_routable(owner_agent_id, 'BINDING');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aun_enforce_provider_channel_access_routable()
RETURNS trigger AS $$
DECLARE
  owner_agent_id TEXT;
BEGIN
  IF NEW.status = 'active' THEN
    owner_agent_id := NEW.agent_id;
    IF owner_agent_id IS NULL AND NEW.connector_instance_id IS NOT NULL THEN
      SELECT ci.agent_id INTO owner_agent_id
        FROM connector_instances ci
       WHERE ci.connector_instance_id = NEW.connector_instance_id;
    END IF;
    PERFORM aun_assert_agent_routable(owner_agent_id, 'ACCESS');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aun_enforce_agent_ui_binding_routable()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('registered', 'active') THEN
    PERFORM aun_assert_agent_routable(NEW.agent_id, 'UI_BINDING');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aun_enforce_workspace_binding_routable()
RETURNS trigger AS $$
BEGIN
  IF COALESCE(NEW.active, false) = true THEN
    PERFORM aun_assert_agent_routable(NEW.agent_id, 'WORKSPACE_BINDING');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aun_enforce_agent_no_active_dependencies()
RETURNS trigger AS $$
BEGIN
  IF (
    NEW.status IN ('disabled', 'retired') OR
    NEW.disabled_at IS NOT NULL OR
    COALESCE(NEW.profile_enabled, true) = false OR
    COALESCE(NEW.historical_only, false) = true OR
    COALESCE(NEW.new_work_allowed, true) = false
  ) AND EXISTS (
    SELECT 1 FROM connector_instances ci
     WHERE ci.agent_id = NEW.agent_id
       AND ci.status IN ('registered', 'active', 'standby', 'draining')
    UNION ALL
    SELECT 1 FROM agent_ui_bindings ub
     WHERE ub.agent_id = NEW.agent_id
       AND ub.status IN ('registered', 'active')
    UNION ALL
    SELECT 1 FROM provider_channel_access pca
     WHERE pca.agent_id = NEW.agent_id
       AND pca.status = 'active'
    UNION ALL
    SELECT 1 FROM agent_workspace_bindings awb
     WHERE awb.agent_id = NEW.agent_id
       AND awb.active = true
    UNION ALL
    SELECT 1 FROM agent_runtime_instances ari
     WHERE ari.agent_id = NEW.agent_id
       AND ari.status IN ('running', 'active')
  ) THEN
    RAISE EXCEPTION 'DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES: %', NEW.agent_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_connector_instances_routable') THEN
    CREATE TRIGGER trg_connector_instances_routable
      BEFORE INSERT OR UPDATE OF agent_id, status ON connector_instances
      FOR EACH ROW EXECUTE FUNCTION aun_enforce_connector_instance_routable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_channel_connector_bindings_routable') THEN
    CREATE TRIGGER trg_channel_connector_bindings_routable
      BEFORE INSERT OR UPDATE OF connector_instance_id, status ON channel_connector_bindings
      FOR EACH ROW EXECUTE FUNCTION aun_enforce_channel_binding_routable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_provider_channel_access_routable') THEN
    CREATE TRIGGER trg_provider_channel_access_routable
      BEFORE INSERT OR UPDATE OF agent_id, connector_instance_id, status ON provider_channel_access
      FOR EACH ROW EXECUTE FUNCTION aun_enforce_provider_channel_access_routable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agent_ui_bindings_routable') THEN
    CREATE TRIGGER trg_agent_ui_bindings_routable
      BEFORE INSERT OR UPDATE OF agent_id, status ON agent_ui_bindings
      FOR EACH ROW EXECUTE FUNCTION aun_enforce_agent_ui_binding_routable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agent_workspace_bindings_routable') THEN
    CREATE TRIGGER trg_agent_workspace_bindings_routable
      BEFORE INSERT OR UPDATE OF agent_id, active ON agent_workspace_bindings
      FOR EACH ROW EXECUTE FUNCTION aun_enforce_workspace_binding_routable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agents_no_disable_with_active_dependencies') THEN
    CREATE TRIGGER trg_agents_no_disable_with_active_dependencies
      BEFORE UPDATE OF status, disabled_at, profile_enabled, historical_only, new_work_allowed ON agents
      FOR EACH ROW EXECUTE FUNCTION aun_enforce_agent_no_active_dependencies();
  END IF;
END $$;
