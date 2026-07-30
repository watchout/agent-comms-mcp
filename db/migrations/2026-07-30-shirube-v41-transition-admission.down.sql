BEGIN;

-- Durable receipt, result, outbox, queue projection, or consumption rows are
-- evidence. Rollback must never erase them implicitly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shirube_v41_transition_receipts)
     OR EXISTS (SELECT 1 FROM shirube_v41_result_consumptions)
     OR EXISTS (SELECT 1 FROM shirube_v41_transition_outbox)
     OR EXISTS (SELECT 1 FROM shirube_v41_queue_projections)
     OR EXISTS (SELECT 1 FROM shirube_v41_receipt_consumptions) THEN
    RAISE EXCEPTION 'SHIRUBE_V41_ROLLBACK_REFUSED_DURABLE_EVIDENCE_PRESENT';
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TABLE IF EXISTS shirube_v41_receipt_consumptions;
DROP TABLE IF EXISTS shirube_v41_queue_projections;
DROP TABLE IF EXISTS shirube_v41_transition_outbox;
DROP TABLE IF EXISTS shirube_v41_result_consumptions;
DROP TABLE IF EXISTS shirube_v41_transition_receipts;
DROP TABLE IF EXISTS shirube_v41_destination_registry;
DROP TABLE IF EXISTS shirube_v41_controller_adapters;
DROP TABLE IF EXISTS shirube_v41_plan_states;
COMMIT;
