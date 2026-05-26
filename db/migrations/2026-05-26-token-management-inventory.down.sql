DROP INDEX IF EXISTS idx_agent_ui_bindings_credential;
DROP INDEX IF EXISTS idx_agent_ui_bindings_connector;
DROP INDEX IF EXISTS idx_agent_ui_bindings_agent_role_live;
DROP INDEX IF EXISTS idx_agent_ui_bindings_ui_live;
DROP INDEX IF EXISTS idx_provider_channel_access_channel;
DROP INDEX IF EXISTS idx_provider_channel_access_agent;
DROP INDEX IF EXISTS idx_provider_channel_access_connector_channel_live;
DROP INDEX IF EXISTS idx_agent_provider_identities_agent_provider;
DROP INDEX IF EXISTS idx_agent_provider_identities_provider_subject_live;
DROP INDEX IF EXISTS idx_connector_credentials_connector;
DROP INDEX IF EXISTS idx_connector_credentials_agent_status;
DROP INDEX IF EXISTS idx_connector_credentials_provider_secret_ref_live;

DROP TABLE IF EXISTS agent_ui_bindings;
DROP TABLE IF EXISTS provider_channel_access;
DROP TABLE IF EXISTS agent_provider_identities;
DROP TABLE IF EXISTS connector_credentials;
