BEGIN;
LOCK TABLE agents IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM agents a WHERE a.desired_revision IS NOT NULL
      AND a.desired_digest = encode(digest(convert_to(aun_canonical_jsonb(aun_configuration_desired_document(a)), 'UTF8'), 'sha256'), 'hex')
      AND a.desired_digest IS DISTINCT FROM encode(digest(convert_to(aun_canonical_jsonb(aun_configuration_legacy_desired_document(a)), 'UTF8'), 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'AUN_DESIRED_FORMAT_ROLLBACK_INCOMPATIBLE: stable desired history cannot be consumed by the prior source';
  END IF;
END $$;
-- Restore prior source functions only. Historical desired rows/outbox remain intact.
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


DROP FUNCTION IF EXISTS aun_configuration_legacy_desired_document(agents);
DROP FUNCTION IF EXISTS aun_configuration_legacy_complete(agents);
COMMIT;
