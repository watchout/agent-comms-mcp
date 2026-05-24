DROP INDEX IF EXISTS idx_agents_profile_enabled;
DROP INDEX IF EXISTS idx_agents_home_directory;

ALTER TABLE agents DROP COLUMN IF EXISTS profile_updated_at;
ALTER TABLE agents DROP COLUMN IF EXISTS profile_source;
ALTER TABLE agents DROP COLUMN IF EXISTS profile_revision;
ALTER TABLE agents DROP COLUMN IF EXISTS profile_enabled;
ALTER TABLE agents DROP COLUMN IF EXISTS expected_provider_identity;
ALTER TABLE agents DROP COLUMN IF EXISTS provider_token_source_ref;
ALTER TABLE agents DROP COLUMN IF EXISTS runtime_engine_preference;
ALTER TABLE agents DROP COLUMN IF EXISTS home_directory;
