BEGIN;

-- Additive and inert by design. No current runtime path imports the V4.1
-- controller modules and this migration does not register an adapter or route.
CREATE TABLE IF NOT EXISTS shirube_v41_plan_states (
  root_goal_run_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK (plan_digest ~ '^(sha256:)?[0-9a-f]{64}$'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  graph_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  parent_graph_id TEXT,
  parent_node_id TEXT,
  state_digest TEXT NOT NULL CHECK (state_digest ~ '^(sha256:)?[0-9a-f]{64}$'),
  subject_tuple JSONB NOT NULL CHECK (jsonb_typeof(subject_tuple) = 'object'),
  graph_state JSONB NOT NULL CHECK (jsonb_typeof(graph_state) = 'object'),
  actor_agent_id TEXT NOT NULL,
  active_function TEXT NOT NULL,
  controller_adapter_id TEXT NOT NULL,
  controller_instance_id TEXT NOT NULL,
  controller_version TEXT NOT NULL,
  dispatch_state TEXT NOT NULL DEFAULT 'LOCAL_READY'
    CHECK (dispatch_state IN ('LOCAL_READY', 'DISPATCH_PENDING', 'ACKNOWLEDGED', 'ADVANCED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (root_goal_run_id, plan_id),
  UNIQUE (plan_digest, generation),
  CHECK ((parent_graph_id IS NULL) = (parent_node_id IS NULL))
);

CREATE TABLE IF NOT EXISTS shirube_v41_controller_adapters (
  controller_adapter_id TEXT PRIMARY KEY,
  authenticated_caller TEXT NOT NULL,
  next_receipt_revision BIGINT NOT NULL DEFAULT 1 CHECK (next_receipt_revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'suspended', 'revoked')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shirube_v41_destination_registry (
  destination_registry_id BIGSERIAL PRIMARY KEY,
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('AGENT_FUNCTION', 'HUMAN_OWNER')),
  destination_actor_agent_id TEXT,
  destination_active_function TEXT,
  destination_owner_principal_id TEXT,
  destination_owner_authority_key TEXT,
  owner_decision_schema TEXT,
  protected_decision_key TEXT,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'suspended', 'revoked')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (destination_kind = 'AGENT_FUNCTION'
      AND destination_actor_agent_id IS NOT NULL AND destination_active_function IS NOT NULL
      AND destination_owner_principal_id IS NULL AND destination_owner_authority_key IS NULL
      AND owner_decision_schema IS NULL)
    OR
    (destination_kind = 'HUMAN_OWNER'
      AND destination_actor_agent_id IS NULL AND destination_active_function IS NULL
      AND destination_owner_principal_id IS NOT NULL AND destination_owner_authority_key IS NOT NULL
      AND owner_decision_schema = 'shirube-v3/owner_decision/v1')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shirube_v41_destination_exact
  ON shirube_v41_destination_registry (
    destination_kind,
    COALESCE(destination_actor_agent_id, ''),
    COALESCE(destination_active_function, ''),
    COALESCE(destination_owner_principal_id, ''),
    COALESCE(destination_owner_authority_key, ''),
    COALESCE(owner_decision_schema, ''),
    COALESCE(protected_decision_key, '')
  ) WHERE lifecycle_state = 'active';

CREATE TABLE IF NOT EXISTS shirube_v41_transition_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^TR-[A-Z0-9._:-]+$'),
  authoritative_store_revision BIGINT NOT NULL UNIQUE CHECK (authoritative_store_revision > 0),
  controller_adapter_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_wire JSONB NOT NULL CHECK (jsonb_typeof(receipt_wire) = 'object'),
  canonical_wire TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  generation BIGINT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('ISSUED', 'CONSUMED', 'REVOKED')),
  committed_transition_record JSONB NOT NULL CHECK (jsonb_typeof(committed_transition_record) = 'object'),
  telemetry JSONB NOT NULL CHECK (jsonb_typeof(telemetry) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (controller_adapter_id, payload_sha256),
  FOREIGN KEY (plan_digest, generation) REFERENCES shirube_v41_plan_states(plan_digest, generation) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS shirube_v41_result_consumptions (
  result_digest TEXT PRIMARY KEY CHECK (result_digest ~ '^(sha256:)?[0-9a-f]{64}$'),
  state_digest TEXT NOT NULL CHECK (state_digest ~ '^(sha256:)?[0-9a-f]{64}$'),
  delivery_class TEXT NOT NULL CHECK (delivery_class IN ('TERMINAL', 'LOCAL_CONTINUE', 'AUN_DELEGATE', 'PROTECTED_DECISION')),
  receipt_wire JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (delivery_class IN ('TERMINAL', 'LOCAL_CONTINUE') AND receipt_wire IS NULL)
    OR (delivery_class IN ('AUN_DELEGATE', 'PROTECTED_DECISION') AND jsonb_typeof(receipt_wire) = 'object')
  )
);

CREATE TABLE IF NOT EXISTS shirube_v41_transition_outbox (
  idempotency_key TEXT PRIMARY KEY CHECK (idempotency_key ~ '^owd:v2:[0-9a-f]{64}$'),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES shirube_v41_transition_receipts(receipt_id) ON DELETE RESTRICT,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_wire JSONB NOT NULL CHECK (jsonb_typeof(receipt_wire) = 'object'),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'acknowledged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS shirube_v41_queue_projections (
  controller_adapter_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  queue_id BIGINT NOT NULL,
  message_id TEXT NOT NULL,
  projection_digest TEXT NOT NULL CHECK (projection_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (controller_adapter_id, receipt_id),
  UNIQUE (message_id),
  UNIQUE (queue_id)
);

CREATE TABLE IF NOT EXISTS shirube_v41_receipt_consumptions (
  controller_adapter_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^owd:v2:[0-9a-f]{64}$'),
  handoff_digest TEXT NOT NULL CHECK (handoff_digest ~ '^(sha256:)?[0-9a-f]{64}$'),
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('AGENT_FUNCTION', 'HUMAN_OWNER')),
  destination_actor_agent_id TEXT,
  destination_active_function TEXT,
  destination_owner_principal_id TEXT,
  destination_owner_authority_key TEXT,
  owner_decision_schema TEXT,
  protected_decision_key TEXT,
  queue_id BIGINT NOT NULL,
  message_id TEXT NOT NULL,
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  provenance_digest TEXT NOT NULL CHECK (provenance_digest ~ '^sha256:[0-9a-f]{64}$'),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (controller_adapter_id, receipt_id),
  UNIQUE (controller_adapter_id, idempotency_key),
  UNIQUE (queue_id),
  UNIQUE (message_id),
  FOREIGN KEY (controller_adapter_id, receipt_id)
    REFERENCES shirube_v41_queue_projections(controller_adapter_id, receipt_id) ON DELETE RESTRICT
);

COMMIT;
