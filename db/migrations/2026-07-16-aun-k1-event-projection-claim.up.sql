BEGIN;

CREATE TABLE IF NOT EXISTS event_log_turn_projection (
  turn_id TEXT PRIMARY KEY,
  received_event_id TEXT NOT NULL UNIQUE,
  seat_id TEXT NOT NULL,
  conversation_id TEXT,
  correlation_id TEXT,
  received_seq BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  message_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  availability TEXT NOT NULL CHECK (availability IN ('available', 'claimed', 'completed')),
  claim_event_id TEXT,
  claim_epoch INTEGER,
  fencing_token BIGINT,
  claim_profile TEXT,
  claimed_by_seat TEXT,
  claimed_by_instance TEXT,
  lease_expires_at TIMESTAMPTZ,
  terminal_event_id TEXT,
  updated_seq BIGINT NOT NULL,
  CHECK (
    (availability = 'available' AND claim_event_id IS NULL AND claimed_by_instance IS NULL AND lease_expires_at IS NULL)
    OR availability IN ('claimed', 'completed')
  )
);

CREATE INDEX IF NOT EXISTS idx_el_turn_projection_claimable
  ON event_log_turn_projection(seat_id, availability, priority DESC, received_seq ASC);
CREATE INDEX IF NOT EXISTS idx_el_turn_projection_expired
  ON event_log_turn_projection(seat_id, lease_expires_at, received_seq)
  WHERE availability = 'claimed';
CREATE INDEX IF NOT EXISTS idx_el_turn_projection_conversation
  ON event_log_turn_projection(seat_id, conversation_id, received_seq)
  WHERE availability <> 'completed';

CREATE OR REPLACE FUNCTION aun_k1_apply_turn_projection_event(p_event event_log)
RETURNS VOID AS $$
DECLARE
  v_profile TEXT;
  v_fence BIGINT;
  v_lease TIMESTAMPTZ;
  v_rows INTEGER;
BEGIN
  IF p_event.turn_id IS NULL THEN
    RETURN;
  END IF;

  IF p_event.event_type = 'message.received' THEN
    INSERT INTO event_log_turn_projection (
      turn_id, received_event_id, seat_id, conversation_id, correlation_id,
      received_seq, received_at, message_id, priority, availability, updated_seq
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
      RAISE EXCEPTION 'K1 claim % has an invalid epoch/fence/lease tuple', p_event.event_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM event_log_turn_projection WHERE turn_id = p_event.turn_id) THEN
      IF v_profile = 'postgres_multi_worker_v1' THEN
        RAISE EXCEPTION 'K1 claim % has no active projection row', p_event.event_id;
      END IF;
      RETURN;
    END IF;

    UPDATE event_log_turn_projection AS p
       SET availability = 'claimed',
           claim_event_id = p_event.event_id,
           claim_epoch = p_event.claim_epoch,
           fencing_token = v_fence,
           claim_profile = v_profile,
           claimed_by_seat = p_event.seat_id,
           claimed_by_instance = p_event.seat_instance_id,
           lease_expires_at = v_lease,
           terminal_event_id = NULL,
           updated_seq = p_event.seq
     WHERE p.turn_id = p_event.turn_id
       AND p.availability <> 'completed'
       AND p_event.claim_epoch = COALESCE(p.claim_epoch + 1, 0)
       AND (
         v_profile IS DISTINCT FROM 'postgres_multi_worker_v1'
         OR v_fence = COALESCE(p.fencing_token + 1, 1)
       )
       AND (
         p.availability = 'available'
         OR (
           p.availability = 'claimed'
           AND p.claim_profile = 'postgres_multi_worker_v1'
           AND p.lease_expires_at IS NOT NULL
           AND p.lease_expires_at <= p_event.occurred_at
         )
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'turn.claimed % did not advance exactly one active projection row', p_event.event_id;
    END IF;
    RETURN;
  END IF;

  IF p_event.event_type = 'turn.claim_released' THEN
    IF NOT EXISTS (SELECT 1 FROM event_log_turn_projection WHERE turn_id = p_event.turn_id) THEN
      RETURN;
    END IF;
    v_fence := NULLIF(p_event.payload->>'fencing_token', '')::BIGINT;
    UPDATE event_log_turn_projection AS p
       SET availability = 'available',
           claim_event_id = NULL,
           claim_profile = NULL,
           claimed_by_seat = NULL,
           claimed_by_instance = NULL,
           lease_expires_at = NULL,
           terminal_event_id = NULL,
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
      RAISE EXCEPTION 'turn.claim_released % did not match the active fence', p_event.event_id;
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
           terminal_event_id = p_event.event_id,
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

CREATE OR REPLACE FUNCTION aun_k1_project_turn_event_trigger()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM aun_k1_apply_turn_projection_event(NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aun_k1_rebuild_turn_projection()
RETURNS VOID AS $$
DECLARE
  v_event event_log%ROWTYPE;
BEGIN
  TRUNCATE TABLE event_log_turn_projection;
  FOR v_event IN SELECT * FROM event_log ORDER BY seq ASC LOOP
    PERFORM aun_k1_apply_turn_projection_event(v_event);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_log_k1_turn_projection ON event_log;
CREATE TRIGGER event_log_k1_turn_projection
  AFTER INSERT ON event_log
  FOR EACH ROW EXECUTE FUNCTION aun_k1_project_turn_event_trigger();

SELECT aun_k1_rebuild_turn_projection();

COMMIT;
