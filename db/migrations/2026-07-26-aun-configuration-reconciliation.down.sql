DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM aun_configuration_restart_requests)
     OR EXISTS (SELECT 1 FROM aun_configuration_observed_state)
     OR EXISTS (SELECT 1 FROM aun_configuration_desired_outbox) THEN
    RAISE EXCEPTION 'refusing to drop nonempty AUN configuration reconciliation evidence';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_agents_aun_configuration_desired_event ON agents;
DROP TRIGGER IF EXISTS trg_agents_aun_configuration_desired_state ON agents;
DROP TABLE IF EXISTS aun_configuration_restart_requests;
DROP TABLE IF EXISTS aun_configuration_observed_state;
DROP TABLE IF EXISTS aun_configuration_desired_outbox;
DROP FUNCTION IF EXISTS append_aun_configuration_desired_event();
DROP FUNCTION IF EXISTS enforce_aun_configuration_desired_state();
DROP FUNCTION IF EXISTS aun_configuration_complete(agents);
DROP FUNCTION IF EXISTS aun_configuration_desired_document(agents);
DROP FUNCTION IF EXISTS aun_canonical_jsonb(JSONB);

ALTER TABLE agents DROP COLUMN IF EXISTS desired_updated_by;
ALTER TABLE agents DROP COLUMN IF EXISTS desired_updated_at;
ALTER TABLE agents DROP COLUMN IF EXISTS desired_control_refs;
ALTER TABLE agents DROP COLUMN IF EXISTS desired_release_tree;
ALTER TABLE agents DROP COLUMN IF EXISTS desired_release_commit;
ALTER TABLE agents DROP COLUMN IF EXISTS desired_digest;
ALTER TABLE agents DROP COLUMN IF EXISTS desired_revision;
ALTER TABLE agents DROP COLUMN IF EXISTS ordinary_projection;
ALTER TABLE agents DROP COLUMN IF EXISTS ordinary_communication_enrollment;
ALTER TABLE agents DROP COLUMN IF EXISTS expected_provider_identity_ref;
ALTER TABLE agents DROP COLUMN IF EXISTS supervisor_identity;
ALTER TABLE agents DROP COLUMN IF EXISTS canonical_home;
ALTER TABLE agents DROP COLUMN IF EXISTS canonical_workspace;
