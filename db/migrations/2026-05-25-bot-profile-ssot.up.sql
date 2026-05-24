ALTER TABLE agents ADD COLUMN IF NOT EXISTS home_directory TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_engine_preference TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider_token_source_ref TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS expected_provider_identity JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;

UPDATE agents
   SET expected_provider_identity = '{}'::jsonb
 WHERE expected_provider_identity IS NULL;

UPDATE agents
   SET profile_enabled = true
 WHERE profile_enabled IS NULL;

UPDATE agents
   SET profile_revision = 1
 WHERE profile_revision IS NULL OR profile_revision < 1;

UPDATE agents
   SET profile_source = 'legacy'
 WHERE profile_source IS NULL OR profile_source = '';

CREATE INDEX IF NOT EXISTS idx_agents_home_directory
  ON agents(org_id, home_directory)
  WHERE home_directory IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agents_profile_enabled
  ON agents(profile_enabled);
