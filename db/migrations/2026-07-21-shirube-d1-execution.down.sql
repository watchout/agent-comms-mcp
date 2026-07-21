BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shirube_d1_effect_deliveries LIMIT 1)
     OR EXISTS (SELECT 1 FROM shirube_d1_invocations LIMIT 1)
     OR EXISTS (SELECT 1 FROM shirube_d1_claims LIMIT 1) THEN
    RAISE EXCEPTION 'refusing Shirube D1 down migration: durable authorization/effect receipts are not empty';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_shirube_d1_effect_reserved;
DROP TABLE IF EXISTS shirube_d1_effect_deliveries;
DROP TABLE IF EXISTS shirube_d1_invocations;
DROP TABLE IF EXISTS shirube_d1_claims;

COMMIT;
