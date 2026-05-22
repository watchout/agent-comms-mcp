DROP INDEX IF EXISTS idx_outbound_queue_channel_binding_pending;
DROP INDEX IF EXISTS idx_outbound_queue_delivery_connector_pending;
DROP INDEX IF EXISTS idx_mq_channel_binding_ordering;
DROP INDEX IF EXISTS idx_mq_assigned_runtime;

ALTER TABLE outbound_queue DROP COLUMN IF EXISTS claimed_runtime_instance_id;
ALTER TABLE outbound_queue DROP COLUMN IF EXISTS channel_binding_id;
ALTER TABLE outbound_queue DROP COLUMN IF EXISTS delivery_connector_instance_id;

ALTER TABLE message_queue DROP COLUMN IF EXISTS ordering_key;
ALTER TABLE message_queue DROP COLUMN IF EXISTS channel_binding_id;
ALTER TABLE message_queue DROP COLUMN IF EXISTS claimed_runtime_instance_id;
ALTER TABLE message_queue DROP COLUMN IF EXISTS assigned_runtime_instance_id;

DROP TABLE IF EXISTS control_plane_leases;
DROP TABLE IF EXISTS channel_connector_bindings;
DROP TABLE IF EXISTS connector_instances;
