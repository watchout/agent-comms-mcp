-- DB-backed desired state and continuous reconciliation contract.
-- Generated provider/plist/runtime surfaces are projections and never write
-- back into the desired columns installed here.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS canonical_workspace TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS canonical_home TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS supervisor_identity TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS expected_provider_identity_ref TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS ordinary_communication_enrollment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS ordinary_projection JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS desired_revision BIGINT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS desired_digest TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS desired_release_commit TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS desired_release_tree TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS desired_control_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS desired_updated_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS desired_updated_by TEXT;

CREATE OR REPLACE FUNCTION aun_canonical_jsonb(input JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE jsonb_typeof(input)
    WHEN 'object' THEN (
      SELECT '{' || COALESCE(string_agg(to_json(key)::text || ':' || aun_canonical_jsonb(value), ',' ORDER BY key COLLATE "C"), '') || '}'
        FROM jsonb_each(input)
    )
    WHEN 'array' THEN (
      SELECT '[' || COALESCE(string_agg(aun_canonical_jsonb(value), ',' ORDER BY ordinal), '') || ']'
        FROM jsonb_array_elements(input) WITH ORDINALITY AS items(value, ordinal)
    )
    WHEN 'number' THEN trim_scale((input #>> '{}')::numeric)::text
    ELSE input::text
  END
$$;

CREATE OR REPLACE FUNCTION aun_configuration_desired_document(input agents)
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'agent_id', input.agent_id,
    'canonical_home', input.canonical_home,
    'canonical_workspace', input.canonical_workspace,
    'channel_port', input.channel_port,
    'control_refs', COALESCE((
      SELECT jsonb_agg(ref ORDER BY ref COLLATE "C")
        FROM (SELECT DISTINCT value #>> '{}' AS ref
                FROM jsonb_array_elements(COALESCE(input.desired_control_refs, '[]'::jsonb))) refs
    ), '[]'::jsonb),
    'expected_provider_identity_ref', input.expected_provider_identity_ref,
    'ordinary_communication_enrollment', input.ordinary_communication_enrollment,
    'ordinary_projection', input.ordinary_projection,
    'profile_enabled', input.profile_enabled,
    'provider_token_source_ref', input.provider_token_source_ref,
    'release_commit', input.desired_release_commit,
    'release_tree', input.desired_release_tree,
    'runtime_engine_preference', input.runtime_engine_preference,
    'supervisor_identity', input.supervisor_identity
  )
$$;

CREATE OR REPLACE FUNCTION aun_configuration_complete(input agents)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT input.agent_id IS NOT NULL AND input.agent_id <> ''
     AND input.profile_enabled IS NOT NULL
     AND input.runtime_engine_preference IS NOT NULL AND input.runtime_engine_preference <> ''
     AND input.canonical_workspace LIKE '/%'
     AND input.canonical_home LIKE '/%'
     AND input.channel_port BETWEEN 1 AND 65535
     AND input.supervisor_identity IS NOT NULL AND input.supervisor_identity <> ''
     AND input.expected_provider_identity_ref IS NOT NULL AND input.expected_provider_identity_ref <> ''
     AND input.desired_release_commit ~ '^[0-9a-f]{40}$'
     AND input.desired_release_tree ~ '^[0-9a-f]{40}$'
     AND jsonb_typeof(input.desired_control_refs) = 'array'
     AND jsonb_array_length(input.desired_control_refs) > 0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(input.desired_control_refs) AS item(value)
        WHERE jsonb_typeof(value) <> 'string'
           OR btrim(value #>> '{}') = ''
           OR value #>> '{}' ~ '[[:cntrl:]]'
     )
     AND jsonb_typeof(input.ordinary_projection) = 'object'
     AND COALESCE(input.ordinary_projection->>'provider_repo_root', '') LIKE '/%'
     AND COALESCE(input.ordinary_projection->>'provider_config_root', '') LIKE '/%'
     AND COALESCE(input.ordinary_projection->>'daemon_checkout', '') LIKE '/%'
$$;

CREATE OR REPLACE FUNCTION enforce_aun_configuration_desired_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_text TEXT;
  next_digest TEXT;
  actor_ref TEXT;
BEGIN
  IF COALESCE(NEW.provider_token_source_ref, '') ~* '(^|[^a-z])(gh[pousr]_|sk-|xox[baprs]-|Bearer[[:space:]]+)[A-Za-z0-9_./+=-]{8,}'
     OR COALESCE(NEW.expected_provider_identity_ref, '') ~* '(^|[^a-z])(gh[pousr]_|sk-|xox[baprs]-|Bearer[[:space:]]+)[A-Za-z0-9_./+=-]{8,}'
     OR COALESCE(NEW.ordinary_projection::text, '') ~* '(^|[^a-z])(gh[pousr]_|sk-|xox[baprs]-|Bearer[[:space:]]+)[A-Za-z0-9_./+=-]{8,}' THEN
    RAISE EXCEPTION 'RAW_SECRET_FORBIDDEN';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.home_directory IS DISTINCT FROM OLD.home_directory THEN
    NEW.canonical_workspace := COALESCE(NULLIF(NEW.home_directory, ''), NEW.canonical_workspace);
    NEW.canonical_home := COALESCE(NULLIF(NEW.home_directory, ''), NEW.canonical_home);
  END IF;
  NEW.supervisor_identity := COALESCE(NULLIF(NEW.supervisor_identity, ''), 'launchd:com.agent-comms.state-daemon');
  IF TG_OP = 'INSERT' OR NEW.expected_provider_identity IS DISTINCT FROM OLD.expected_provider_identity
     OR NEW.expected_provider_identity_ref IS NULL OR NEW.expected_provider_identity_ref = '' THEN
    NEW.expected_provider_identity_ref := 'agent-profile:' || NEW.agent_id || ':expected-provider-identity:' ||
      encode(digest(convert_to(aun_canonical_jsonb(COALESCE(NEW.expected_provider_identity, '{}'::jsonb)), 'UTF8'), 'sha256'), 'hex');
  END IF;
  NEW.ordinary_projection := CASE
    WHEN NEW.ordinary_projection IS NULL OR NEW.ordinary_projection = '{}'::jsonb
      THEN jsonb_build_object('owner', 'continuous-reconciler', 'schema_version', 'aun-configuration-projection/v1')
    ELSE NEW.ordinary_projection
  END;
  NEW.desired_release_commit := COALESCE(NULLIF(NEW.desired_release_commit, ''), 'b09a7bd5deca0e4814d1f6e57455579ba7af2c50');
  NEW.desired_release_tree := COALESCE(NULLIF(NEW.desired_release_tree, ''), '20fd33be3849089516655238c14fc0af6e746222');
  IF NEW.desired_control_refs IS NULL OR NEW.desired_control_refs = '[]'::jsonb THEN
    NEW.desired_control_refs := jsonb_build_array('https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-5082585803');
  END IF;

  IF NOT aun_configuration_complete(NEW) THEN
    NEW.desired_revision := NULL;
    NEW.desired_digest := NULL;
    NEW.desired_updated_at := NULL;
    NEW.desired_updated_by := NULL;
    RETURN NEW;
  END IF;

  canonical_text := aun_canonical_jsonb(aun_configuration_desired_document(NEW));
  next_digest := encode(digest(convert_to(canonical_text, 'UTF8'), 'sha256'), 'hex');
  IF TG_OP = 'UPDATE' AND OLD.desired_digest IS NOT DISTINCT FROM next_digest THEN
    NEW.desired_revision := OLD.desired_revision;
    NEW.desired_digest := OLD.desired_digest;
    NEW.desired_updated_at := OLD.desired_updated_at;
    NEW.desired_updated_by := OLD.desired_updated_by;
    RETURN NEW;
  END IF;

  NEW.desired_revision := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.desired_revision, 0) + 1 ELSE 1 END;
  NEW.desired_digest := next_digest;
  NEW.desired_updated_at := clock_timestamp();
  actor_ref := NULLIF(current_setting('aun.actor_ref', true), '');
  NEW.desired_updated_by := COALESCE(actor_ref, NULLIF(NEW.profile_source, ''), current_user);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_aun_configuration_desired_state ON agents;
CREATE TRIGGER trg_agents_aun_configuration_desired_state
  BEFORE INSERT OR UPDATE OF
    profile_enabled, runtime_engine_preference, home_directory,
    canonical_workspace, canonical_home, channel_port, supervisor_identity,
    expected_provider_identity, expected_provider_identity_ref, provider_token_source_ref,
    ordinary_communication_enrollment, ordinary_projection,
    desired_release_commit, desired_release_tree, desired_control_refs
  ON agents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_aun_configuration_desired_state();

CREATE TABLE IF NOT EXISTS aun_configuration_desired_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  desired_revision BIGINT NOT NULL CHECK (desired_revision > 0),
  desired_digest TEXT NOT NULL CHECK (desired_digest ~ '^[0-9a-f]{64}$'),
  event_type TEXT NOT NULL CHECK (event_type = 'AUN_AGENT_CONFIGURATION_DESIRED_CHANGED'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (agent_id, desired_revision)
);

CREATE INDEX IF NOT EXISTS idx_aun_configuration_outbox_pending
  ON aun_configuration_desired_outbox(available_at, desired_revision, agent_id)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION append_aun_configuration_desired_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_event_id UUID;
BEGIN
  IF NEW.desired_revision IS NULL OR NEW.desired_digest IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.desired_revision IS NOT DISTINCT FROM NEW.desired_revision
     AND OLD.desired_digest IS NOT DISTINCT FROM NEW.desired_digest THEN
    RETURN NEW;
  END IF;
  INSERT INTO aun_configuration_desired_outbox (
    agent_id, desired_revision, desired_digest, event_type
  ) VALUES (
    NEW.agent_id, NEW.desired_revision, NEW.desired_digest, 'AUN_AGENT_CONFIGURATION_DESIRED_CHANGED'
  )
  ON CONFLICT (agent_id, desired_revision) DO NOTHING
  RETURNING event_id INTO new_event_id;
  IF new_event_id IS NOT NULL THEN
    PERFORM pg_notify('aun_configuration_desired_changed', json_build_object(
      'event_id', new_event_id,
      'agent_id', NEW.agent_id,
      'desired_revision', NEW.desired_revision,
      'desired_digest', NEW.desired_digest
    )::text);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_aun_configuration_desired_event ON agents;
CREATE TRIGGER trg_agents_aun_configuration_desired_event
  AFTER INSERT OR UPDATE OF
    profile_enabled, runtime_engine_preference, home_directory,
    canonical_workspace, canonical_home, channel_port, supervisor_identity,
    expected_provider_identity, expected_provider_identity_ref, provider_token_source_ref,
    ordinary_communication_enrollment, ordinary_projection,
    desired_release_commit, desired_release_tree, desired_control_refs
  ON agents
  FOR EACH ROW
  EXECUTE FUNCTION append_aun_configuration_desired_event();

-- Initialize only complete profiles. Incomplete inventory remains explicitly
-- unconfigured; a complete disabled profile is still revisioned desired state.
UPDATE agents
   SET canonical_workspace = COALESCE(NULLIF(canonical_workspace, ''), home_directory),
       canonical_home = COALESCE(NULLIF(canonical_home, ''), home_directory),
       supervisor_identity = COALESCE(NULLIF(supervisor_identity, ''), 'launchd:com.agent-comms.state-daemon'),
       ordinary_projection = CASE WHEN ordinary_projection = '{}'::jsonb
         THEN jsonb_build_object('owner', 'continuous-reconciler', 'schema_version', 'aun-configuration-projection/v1')
         ELSE ordinary_projection END,
       desired_release_commit = COALESCE(NULLIF(desired_release_commit, ''), 'b09a7bd5deca0e4814d1f6e57455579ba7af2c50'),
       desired_release_tree = COALESCE(NULLIF(desired_release_tree, ''), '20fd33be3849089516655238c14fc0af6e746222'),
       desired_control_refs = CASE WHEN desired_control_refs = '[]'::jsonb
         THEN jsonb_build_array('https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-5082585803')
         ELSE desired_control_refs END
 WHERE runtime_engine_preference IS NOT NULL
   AND runtime_engine_preference <> ''
   AND home_directory IS NOT NULL
   AND home_directory <> ''
   AND channel_port BETWEEN 1 AND 65535;

CREATE TABLE IF NOT EXISTS aun_configuration_observed_state (
  host_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  observed_revision BIGINT NOT NULL CHECK (observed_revision > 0),
  observed_desired_digest TEXT NOT NULL CHECK (observed_desired_digest ~ '^[0-9a-f]{64}$'),
  candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  release_commit TEXT NOT NULL CHECK (release_commit ~ '^[0-9a-f]{40}$'),
  release_tree TEXT NOT NULL CHECK (release_tree ~ '^[0-9a-f]{40}$'),
  provider_native_digest TEXT NOT NULL CHECK (provider_native_digest ~ '^[0-9a-f]{64}$'),
  launchagent_plist_digest TEXT NOT NULL CHECK (launchagent_plist_digest ~ '^[0-9a-f]{64}$'),
  launchctl_environment_digest TEXT NOT NULL CHECK (launchctl_environment_digest ~ '^[0-9a-f]{64}$'),
  runtime_identity_digest TEXT NOT NULL CHECK (runtime_identity_digest ~ '^[0-9a-f]{64}$'),
  reconcile_status TEXT NOT NULL CHECK (reconcile_status IN (
    'READY', 'RECONCILING', 'DEGRADED_APPROVAL_REQUIRED', 'DEGRADED_DB_UNAVAILABLE',
    'DRIFTED', 'NO_GO_STALE_CANDIDATE', 'NO_GO_PARTIAL_APPLY', 'NO_GO_ROLLBACK'
  )),
  drift_reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(drift_reason_codes) = 'array'),
  lease_id UUID NOT NULL REFERENCES control_plane_leases(lease_id) ON DELETE RESTRICT,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, agent_id)
);

CREATE TABLE IF NOT EXISTS aun_configuration_restart_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  from_revision BIGINT,
  from_digest TEXT CHECK (from_digest IS NULL OR from_digest ~ '^[0-9a-f]{64}$'),
  to_revision BIGINT NOT NULL CHECK (to_revision > 0),
  to_digest TEXT NOT NULL CHECK (to_digest ~ '^[0-9a-f]{64}$'),
  candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  rollback_artifact_digest TEXT NOT NULL CHECK (rollback_artifact_digest ~ '^[0-9a-f]{64}$'),
  exact_release_commit TEXT NOT NULL CHECK (exact_release_commit ~ '^[0-9a-f]{40}$'),
  exact_release_tree TEXT NOT NULL CHECK (exact_release_tree ~ '^[0-9a-f]{40}$'),
  exact_control_refs JSONB NOT NULL CHECK (jsonb_typeof(exact_control_refs) = 'array'),
  lease_id UUID NOT NULL REFERENCES control_plane_leases(lease_id) ON DELETE RESTRICT,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  restart_budget INTEGER NOT NULL CHECK (restart_budget = 1),
  status TEXT NOT NULL DEFAULT 'AWAITING_OWNER_DECISION' CHECK (status IN (
    'AWAITING_OWNER_DECISION', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED'
  )),
  owner_decision_ref TEXT,
  cto_execution_receipt_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (host_id, agent_id, to_revision, to_digest, candidate_digest),
  CHECK (from_revision IS NULL OR from_revision <= to_revision)
);
