-- Ordinary all-agent communication manifest support. This is intentionally
-- separate from every Shirube D1 authority/receipt table.
CREATE TABLE IF NOT EXISTS all_agent_communication_manifest_revisions (
  manifest_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  schema_version TEXT NOT NULL CHECK (schema_version = 'all-agent-communication-manifest/v1'),
  lifecycle_status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (lifecycle_status IN ('candidate', 'accepted', 'superseded', 'revoked', 'expired')),
  issued_at TIMESTAMPTZ NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  owner_decision_ref TEXT NOT NULL,
  owner_pinned_digest TEXT NOT NULL CHECK (owner_pinned_digest ~ '^[0-9a-f]{64}$'),
  target_count INTEGER NOT NULL CHECK (target_count > 0),
  target_sha256 TEXT NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
  release_commit TEXT NOT NULL CHECK (release_commit ~ '^[0-9a-f]{40}$'),
  release_tree TEXT NOT NULL CHECK (release_tree ~ '^[0-9a-f]{40}$'),
  artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  canonical_manifest JSONB NOT NULL,
  revoked_or_superseded_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_id, revision),
  UNIQUE (artifact_digest),
  CHECK (issued_at <= not_before AND not_before < expires_at),
  CHECK (jsonb_typeof(canonical_manifest) = 'object'),
  CHECK (jsonb_typeof(revoked_or_superseded_refs) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_all_agent_manifest_one_accepted
  ON all_agent_communication_manifest_revisions(manifest_id)
  WHERE lifecycle_status = 'accepted';

CREATE TABLE IF NOT EXISTS all_agent_communication_manifest_targets (
  manifest_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  agent_id TEXT NOT NULL CHECK (agent_id ~ '^[a-z0-9][a-z0-9-]*$'),
  target_repository TEXT NOT NULL CHECK (target_repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  control_source TEXT NOT NULL,
  active_function TEXT NOT NULL CHECK (active_function IN (
    'control_source_author', 'control_artifact_author', 'coordination_recorder',
    'implementation_executor', 'evidence_audit_gate', 'scenario_verification_gate',
    'operator_acceptance_gate', 'protected_surface_gate', 'orchestration_controller',
    'runtime_recovery_executor', 'revenue_demand_owner', 'revenue_sales_owner'
  )),
  workspace_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL CHECK (workspace_path LIKE '/%'),
  runtime_engine TEXT NOT NULL CHECK (runtime_engine IN ('codex-exec', 'claude-exec')),
  runtime_profile_ref TEXT NOT NULL,
  provider_identity_ref TEXT NOT NULL,
  communication_auto_receive BOOLEAN NOT NULL,
  protected_d1 BOOLEAN NOT NULL,
  discord_mode TEXT NOT NULL CHECK (discord_mode IN ('native_verified', 'aun_gateway_projection')),
  target_digest TEXT NOT NULL CHECK (target_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_id, revision, agent_id),
  UNIQUE (manifest_id, revision, ordinal),
  FOREIGN KEY (manifest_id, revision)
    REFERENCES all_agent_communication_manifest_revisions(manifest_id, revision)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_all_agent_manifest_targets_workspace
  ON all_agent_communication_manifest_targets(workspace_id);

CREATE TABLE IF NOT EXISTS all_agent_communication_manifest_projections (
  manifest_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  agent_id TEXT NOT NULL,
  observed_target_digest TEXT CHECK (
    observed_target_digest IS NULL OR observed_target_digest ~ '^[0-9a-f]{64}$'
  ),
  projection_status TEXT NOT NULL CHECK (projection_status IN ('match', 'drift', 'missing', 'ambiguous')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_id, revision, agent_id, observed_at),
  CHECK (
    (projection_status = 'missing' AND observed_target_digest IS NULL)
    OR (projection_status <> 'missing' AND observed_target_digest IS NOT NULL)
  ),
  FOREIGN KEY (manifest_id, revision)
    REFERENCES all_agent_communication_manifest_revisions(manifest_id, revision)
    ON DELETE RESTRICT
);
