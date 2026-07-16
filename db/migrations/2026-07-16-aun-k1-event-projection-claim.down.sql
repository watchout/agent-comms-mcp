BEGIN;

DROP TRIGGER IF EXISTS event_log_k1_turn_projection ON event_log;
DROP FUNCTION IF EXISTS aun_k1_project_turn_event_trigger();
DROP FUNCTION IF EXISTS aun_k1_rebuild_turn_projection();
DROP FUNCTION IF EXISTS aun_k1_apply_turn_projection_event(event_log);
DROP TABLE IF EXISTS event_log_turn_projection;

COMMIT;
