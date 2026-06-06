CREATE TABLE IF NOT EXISTS runtime_memory_ready_evidence (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  profile_revision INTEGER,
  profile_source TEXT,
  session_name TEXT NOT NULL,
  port INTEGER NOT NULL,
  expected_agent_id TEXT NOT NULL,
  checkout_path TEXT,
  checkout_commit_sha TEXT,
  recovery_command TEXT NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('ready', 'failed', 'bypassed')),
  failure_reason TEXT,
  completed_at TIMESTAMPTZ NOT NULL,
  evidence_path TEXT,
  evidence_log_id TEXT,
  valid_until TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_latest
  ON runtime_memory_ready_evidence(agent_id, project, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_runtime
  ON runtime_memory_ready_evidence(runtime_instance_id, valid_until DESC);
