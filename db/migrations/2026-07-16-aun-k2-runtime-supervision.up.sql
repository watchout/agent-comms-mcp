BEGIN;

ALTER TABLE event_log_turn_projection
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terminal_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_failure_code TEXT;

UPDATE event_log_turn_projection
   SET available_at = received_at
 WHERE availability = 'available' AND available_at IS NULL;

ALTER TABLE event_log_turn_projection
  DROP CONSTRAINT IF EXISTS event_log_turn_projection_check;
ALTER TABLE event_log_turn_projection
  DROP CONSTRAINT IF EXISTS event_log_turn_projection_availability_check;
ALTER TABLE event_log_turn_projection
  DROP CONSTRAINT IF EXISTS event_log_turn_projection_attempt_count_check;
ALTER TABLE event_log_turn_projection
  DROP CONSTRAINT IF EXISTS event_log_turn_projection_state_check;
ALTER TABLE event_log_turn_projection
  ADD CONSTRAINT event_log_turn_projection_availability_check
  CHECK (availability IN ('available', 'claimed', 'retry_wait', 'blocked', 'dead_lettered', 'completed'));
ALTER TABLE event_log_turn_projection
  ADD CONSTRAINT event_log_turn_projection_attempt_count_check
  CHECK (attempt_count >= 0);
ALTER TABLE event_log_turn_projection
  ADD CONSTRAINT event_log_turn_projection_state_check
  CHECK (
    (
      availability = 'available'
      AND claim_event_id IS NULL
      AND claimed_by_instance IS NULL
      AND lease_expires_at IS NULL
      AND available_at IS NOT NULL
    )
    OR availability IN ('claimed', 'retry_wait', 'blocked', 'dead_lettered', 'completed')
  );

DROP INDEX IF EXISTS idx_el_turn_projection_claimable;
CREATE INDEX idx_el_turn_projection_claimable
  ON event_log_turn_projection(
    seat_id, availability, available_at, priority DESC, received_seq ASC
  );

CREATE OR REPLACE FUNCTION aun_k1_apply_turn_projection_event(p_event event_log)
RETURNS VOID AS $$
DECLARE
  v_profile TEXT;
  v_fence BIGINT;
  v_lease TIMESTAMPTZ;
  v_available_at TIMESTAMPTZ;
  v_rows INTEGER;
BEGIN
  IF p_event.turn_id IS NULL THEN
    RETURN;
  END IF;

  IF p_event.event_type = 'message.received' THEN
    INSERT INTO event_log_turn_projection (
      turn_id, received_event_id, seat_id, conversation_id, correlation_id,
      received_seq, received_at, message_id, priority, availability,
      available_at, attempt_count, updated_seq
    ) VALUES (
      p_event.turn_id,
      p_event.event_id,
      p_event.seat_id,
      p_event.conversation_id,
      p_event.correlation_id,
      p_event.seq,
      p_event.occurred_at,
      p_event.payload->>'message_id',
      CASE
        WHEN COALESCE(p_event.payload->>'priority', '') ~ '^-?[0-9]+$'
          THEN (p_event.payload->>'priority')::INTEGER
        ELSE 0
      END,
      'available',
      p_event.occurred_at,
      0,
      p_event.seq
    )
    ON CONFLICT (turn_id) DO NOTHING;
    RETURN;
  END IF;

  IF p_event.event_type = 'turn.claimed' THEN
    v_profile := NULLIF(p_event.payload->>'claim_profile', '');
    v_fence := NULLIF(p_event.payload->>'fencing_token', '')::BIGINT;
    v_lease := NULLIF(p_event.payload->>'lease_expires_at', '')::TIMESTAMPTZ;

    IF v_profile = 'postgres_multi_worker_v1' AND (
      p_event.claim_epoch IS NULL OR v_fence IS NULL OR v_lease IS NULL
      OR v_lease <= p_event.occurred_at
    ) THEN
      RAISE EXCEPTION 'K2 claim % has an invalid epoch/fence/lease tuple', p_event.event_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM event_log_turn_projection WHERE turn_id = p_event.turn_id) THEN
      IF v_profile = 'postgres_multi_worker_v1' THEN
        RAISE EXCEPTION 'K2 claim % has no active projection row', p_event.event_id;
      END IF;
      RETURN;
    END IF;

    UPDATE event_log_turn_projection AS p
       SET availability = 'claimed',
           available_at = NULL,
           claim_event_id = p_event.event_id,
           claim_epoch = p_event.claim_epoch,
           fencing_token = v_fence,
           claim_profile = v_profile,
           claimed_by_seat = p_event.seat_id,
           claimed_by_instance = p_event.seat_instance_id,
           lease_expires_at = v_lease,
           terminal_event_id = NULL,
           terminal_reason = NULL,
           updated_seq = p_event.seq
     WHERE p.turn_id = p_event.turn_id
       AND p.availability NOT IN ('completed', 'blocked', 'dead_lettered')
       AND p_event.claim_epoch = COALESCE(p.claim_epoch + 1, 0)
       AND (
         v_profile IS DISTINCT FROM 'postgres_multi_worker_v1'
         OR v_fence = COALESCE(p.fencing_token + 1, 1)
       )
       AND (
         p.availability = 'available'
         OR (p.availability = 'retry_wait' AND p.available_at IS NOT NULL AND p.available_at <= p_event.occurred_at)
         OR (
           p.availability = 'claimed'
           AND p.claim_profile = 'postgres_multi_worker_v1'
           AND p.lease_expires_at IS NOT NULL
           AND p.lease_expires_at <= p_event.occurred_at
         )
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'turn.claimed % did not advance exactly one active K2 projection row', p_event.event_id;
    END IF;
    RETURN;
  END IF;

  IF p_event.event_type = 'turn.attempt_failed' THEN
    v_fence := NULLIF(p_event.payload->>'fencing_token', '')::BIGINT;
    UPDATE event_log_turn_projection AS p
       SET attempt_count = p.attempt_count + 1,
           last_failure_code = NULLIF(p_event.payload->>'failure_code', ''),
           updated_seq = p_event.seq
     WHERE p.turn_id = p_event.turn_id
       AND p.availability = 'claimed'
       AND p.claim_event_id = p_event.causation_id
       AND p.claim_epoch = p_event.claim_epoch
       AND (
         p.claim_profile IS DISTINCT FROM 'postgres_multi_worker_v1'
         OR (v_fence = p.fencing_token AND p.lease_expires_at > p_event.occurred_at)
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'turn.attempt_failed % did not match the active fence', p_event.event_id;
    END IF;
    RETURN;
  END IF;

  IF p_event.event_type = 'turn.retry_scheduled' THEN
    v_fence := NULLIF(p_event.payload->>'fencing_token', '')::BIGINT;
    v_available_at := NULLIF(p_event.payload->>'available_at', '')::TIMESTAMPTZ;
    IF v_available_at IS NULL THEN
      RAISE EXCEPTION 'turn.retry_scheduled % has no available_at', p_event.event_id;
    END IF;
    UPDATE event_log_turn_projection AS p
       SET availability = 'retry_wait',
           available_at = v_available_at,
           terminal_event_id = NULL,
           terminal_reason = NULL,
           updated_seq = p_event.seq
     WHERE p.turn_id = p_event.turn_id
       AND p.availability = 'claimed'
       AND p.claim_epoch = p_event.claim_epoch
       AND p.claimed_by_seat = p_event.seat_id
       AND p.claimed_by_instance = p_event.seat_instance_id
       AND (
         p.claim_profile IS DISTINCT FROM 'postgres_multi_worker_v1'
         OR (v_fence = p.fencing_token AND p.lease_expires_at > p_event.occurred_at)
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'turn.retry_scheduled % did not match the active fence', p_event.event_id;
    END IF;
    RETURN;
  END IF;

  IF p_event.event_type = 'turn.claim_released' THEN
    IF NOT EXISTS (SELECT 1 FROM event_log_turn_projection WHERE turn_id = p_event.turn_id) THEN
      RETURN;
    END IF;
    v_fence := NULLIF(p_event.payload->>'fencing_token', '')::BIGINT;
    UPDATE event_log_turn_projection AS p
       SET availability = CASE WHEN p.availability = 'retry_wait' THEN 'retry_wait' ELSE 'available' END,
           available_at = CASE WHEN p.availability = 'retry_wait' THEN p.available_at ELSE p_event.occurred_at END,
           claim_event_id = NULL,
           claim_profile = NULL,
           claimed_by_seat = NULL,
           claimed_by_instance = NULL,
           lease_expires_at = NULL,
           terminal_event_id = NULL,
           updated_seq = p_event.seq
     WHERE p.turn_id = p_event.turn_id
       AND p.availability IN ('claimed', 'retry_wait')
       AND p.claim_event_id = p_event.causation_id
       AND p.claim_epoch = p_event.claim_epoch
       AND (
         p.claim_profile IS DISTINCT FROM 'postgres_multi_worker_v1'
         OR (v_fence = p.fencing_token AND p.lease_expires_at > p_event.occurred_at)
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'turn.claim_released % did not match the active K2 fence', p_event.event_id;
    END IF;
    RETURN;
  END IF;

  IF p_event.event_type IN ('turn.blocked', 'turn.dead_lettered') THEN
    v_fence := NULLIF(p_event.payload->>'fencing_token', '')::BIGINT;
    UPDATE event_log_turn_projection AS p
       SET availability = CASE WHEN p_event.event_type = 'turn.blocked' THEN 'blocked' ELSE 'dead_lettered' END,
           available_at = NULL,
           terminal_event_id = p_event.event_id,
           terminal_reason = NULLIF(p_event.payload->>'reason_code', ''),
           attempt_count = CASE
             WHEN p_event.event_type = 'turn.dead_lettered'
               THEN GREATEST(p.attempt_count, COALESCE(NULLIF(p_event.payload->>'attempt_count', '')::INTEGER, p.attempt_count))
             ELSE p.attempt_count
           END,
           updated_seq = p_event.seq
     WHERE p.turn_id = p_event.turn_id
       AND p.availability = 'claimed'
       AND p.claim_event_id = p_event.causation_id
       AND p.claim_epoch = p_event.claim_epoch
       AND (
         p.claim_profile IS DISTINCT FROM 'postgres_multi_worker_v1'
         OR (v_fence = p.fencing_token AND p.lease_expires_at > p_event.occurred_at)
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '% % did not match the active fence', p_event.event_type, p_event.event_id;
    END IF;
    RETURN;
  END IF;

  IF p_event.event_type = 'turn.completed' THEN
    IF NOT EXISTS (SELECT 1 FROM event_log_turn_projection WHERE turn_id = p_event.turn_id) THEN
      RETURN;
    END IF;
    v_fence := NULLIF(p_event.payload->>'fencing_token', '')::BIGINT;
    UPDATE event_log_turn_projection AS p
       SET availability = 'completed',
           available_at = NULL,
           terminal_event_id = p_event.event_id,
           terminal_reason = NULLIF(p_event.payload->>'outcome', ''),
           updated_seq = p_event.seq
     WHERE p.turn_id = p_event.turn_id
       AND p.availability = 'claimed'
       AND p.claim_event_id = p_event.causation_id
       AND (p_event.claim_epoch IS NULL OR p.claim_epoch = p_event.claim_epoch)
       AND (
         p.claim_profile IS DISTINCT FROM 'postgres_multi_worker_v1'
         OR (v_fence = p.fencing_token AND p.lease_expires_at > p_event.occurred_at)
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'turn.completed % did not match the active fence', p_event.event_id;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT aun_k1_rebuild_turn_projection();

COMMIT;
