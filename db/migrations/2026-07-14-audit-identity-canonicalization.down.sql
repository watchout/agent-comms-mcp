DROP TRIGGER IF EXISTS trg_agents_no_disable_with_active_dependencies ON agents;
DROP TRIGGER IF EXISTS trg_agent_workspace_bindings_routable ON agent_workspace_bindings;
DROP TRIGGER IF EXISTS trg_agent_ui_bindings_routable ON agent_ui_bindings;
DROP TRIGGER IF EXISTS trg_provider_channel_access_routable ON provider_channel_access;
DROP TRIGGER IF EXISTS trg_channel_connector_bindings_routable ON channel_connector_bindings;
DROP TRIGGER IF EXISTS trg_connector_instances_routable ON connector_instances;

DROP FUNCTION IF EXISTS aun_enforce_agent_no_active_dependencies();
DROP FUNCTION IF EXISTS aun_enforce_workspace_binding_routable();
DROP FUNCTION IF EXISTS aun_enforce_agent_ui_binding_routable();
DROP FUNCTION IF EXISTS aun_enforce_provider_channel_access_routable();
DROP FUNCTION IF EXISTS aun_enforce_channel_binding_routable();
DROP FUNCTION IF EXISTS aun_enforce_connector_instance_routable();
DROP FUNCTION IF EXISTS aun_assert_agent_routable(TEXT, TEXT);
DROP FUNCTION IF EXISTS aun_agent_is_routable(TEXT);

DROP INDEX IF EXISTS idx_role_routing_active_function;
DROP INDEX IF EXISTS idx_agents_routable;

ALTER TABLE role_routing
  DROP COLUMN IF EXISTS historical_only,
  DROP COLUMN IF EXISTS canonical_seat,
  DROP COLUMN IF EXISTS active_function;

ALTER TABLE agents
  DROP COLUMN IF EXISTS new_work_allowed,
  DROP COLUMN IF EXISTS historical_only;
