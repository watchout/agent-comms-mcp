BEGIN;

CREATE TABLE IF NOT EXISTS shirube_d1_claims (
  claim_key TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL,
  authorization_digest TEXT NOT NULL,
  control_source TEXT NOT NULL,
  exact_base_sha TEXT NOT NULL,
  allowed_paths_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'claimed'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shirube_d1_invocations (
  invocation_key TEXT PRIMARY KEY,
  claim_key TEXT NOT NULL REFERENCES shirube_d1_claims(claim_key) ON DELETE RESTRICT,
  handoff_id TEXT NOT NULL,
  authorization_digest TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('internal_reply', 'github_writeback', 'external_send')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed')),
  internal_reply_receipt TEXT,
  github_writeback_receipt TEXT,
  external_send_receipt TEXT,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'reserved' AND completed_at IS NULL AND internal_reply_receipt IS NULL AND github_writeback_receipt IS NULL AND external_send_receipt IS NULL)
    OR
    (status = 'completed' AND completed_at IS NOT NULL AND
      ((effect = 'internal_reply' AND internal_reply_receipt IS NOT NULL AND github_writeback_receipt IS NULL AND external_send_receipt IS NULL)
      OR (effect = 'github_writeback' AND internal_reply_receipt IS NULL AND github_writeback_receipt IS NOT NULL AND external_send_receipt IS NULL)
      OR (effect = 'external_send' AND internal_reply_receipt IS NULL AND github_writeback_receipt IS NULL AND external_send_receipt IS NOT NULL)))
  )
);

CREATE TABLE IF NOT EXISTS shirube_d1_effect_deliveries (
  invocation_key TEXT PRIMARY KEY REFERENCES shirube_d1_invocations(invocation_key) ON DELETE RESTRICT,
  effect TEXT NOT NULL CHECK (effect IN ('internal_reply', 'github_writeback', 'external_send')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed')),
  receipt TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'reserved' AND receipt IS NULL) OR (status = 'completed' AND receipt IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_shirube_d1_effect_reserved
  ON shirube_d1_effect_deliveries(status, lease_expires_at)
  WHERE status = 'reserved';

COMMIT;
