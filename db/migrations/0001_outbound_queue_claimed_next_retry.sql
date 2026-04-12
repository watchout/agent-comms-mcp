-- S2-A outbound forwarder unification (FEAT-005, route:ceo-approval)
-- Plan: docs/plans/outbound-forwarder-unification.md §3 / schema migration
-- Adds claimed_at + next_retry_at to outbound_queue to support atomic claim
-- (status='processing' flip + agent_id filter) and exponential backoff.
-- CEO approval: 2026-04-12 23:07 UTC.
--
-- Idempotent: safe to re-run. status CHECK already allows 'processing'
-- (added earlier); not re-asserted here per plan §1.4 note.

ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL;
ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_queue_processing_claimed_at
  ON outbound_queue(status, claimed_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_outbound_queue_agent_pending_next_retry
  ON outbound_queue(agent_id, status, next_retry_at)
  WHERE status = 'pending';
