CREATE TABLE IF NOT EXISTS worker_activity (
  activity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
  lease_id UUID REFERENCES control_plane_leases(lease_id) ON DELETE SET NULL,
  queue_id BIGINT REFERENCES message_queue(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL DEFAULT 'worker',
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT NOT NULL,
  repository TEXT,
  branch TEXT,
  pull_request TEXT,
  artifact_uri TEXT,
  blocked_reason TEXT,
  handoff_target_agent_id TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
  progress_percent INTEGER,
  progress_label TEXT,
  stale_after_sec INTEGER NOT NULL DEFAULT 120,
  started_at TIMESTAMPTZ DEFAULT now(),
  heartbeat_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$ BEGIN
  ALTER TABLE worker_activity ADD CONSTRAINT worker_activity_status_check
    CHECK (status IN ('planned', 'running', 'blocked', 'stalled', 'failed', 'completed', 'handoff'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE worker_activity ADD COLUMN IF NOT EXISTS progress_percent INTEGER;
  ALTER TABLE worker_activity ADD COLUMN IF NOT EXISTS progress_label TEXT;
  ALTER TABLE worker_activity ADD COLUMN IF NOT EXISTS stale_after_sec INTEGER NOT NULL DEFAULT 120;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE worker_activity ADD CONSTRAINT worker_activity_progress_percent_check
    CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE worker_activity ADD CONSTRAINT worker_activity_stale_after_sec_check
    CHECK (stale_after_sec > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_worker_activity_open
  ON worker_activity(agent_id, status, updated_at DESC)
  WHERE status IN ('planned', 'running', 'blocked', 'stalled');
CREATE INDEX IF NOT EXISTS idx_worker_activity_queue
  ON worker_activity(queue_id)
  WHERE queue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_worker_activity_runtime
  ON worker_activity(runtime_instance_id, status, updated_at DESC)
  WHERE runtime_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_worker_activity_repo
  ON worker_activity(repository, branch, updated_at DESC)
  WHERE repository IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_worker_activity_handoff
  ON worker_activity(handoff_target_agent_id, status, updated_at DESC)
  WHERE handoff_target_agent_id IS NOT NULL;
