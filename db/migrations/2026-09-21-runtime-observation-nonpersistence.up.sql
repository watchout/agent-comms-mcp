-- Owner adopted D1-D4: no observation writes; existing physical/history bytes retained.
-- One transaction; no UPDATE/DELETE of historical rows, no runtime-row replacement.
BEGIN;
CREATE OR REPLACE FUNCTION aun_np_json_valid(n jsonb, o jsonb, spec jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; t jsonb; kind text; previous jsonb; value jsonb;
BEGIN
 n:=COALESCE(n,'{}'::jsonb); o:=COALESCE(o,'{}'::jsonb);
 IF n=o THEN RETURN true; END IF;
 IF spec='"logical"'::jsonb THEN
   IF jsonb_typeof(n)='object' OR jsonb_typeof(o)='object' THEN
     FOR k IN SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(n)='object' THEN n ELSE '{}'::jsonb END||CASE WHEN jsonb_typeof(o)='object' THEN o ELSE '{}'::jsonb END) LOOP
       value:=n->k; previous:=o->k;
       IF lower(replace(replace(k,'_',''),'-',''))=ANY(ARRAY['provider','actualprovider','providerobservation','nativedelivery','providerpid','providerstartedat','providerexecutablesha256','workspacesha256','pipesha256','hostsessionid','runtimeengine','runtime','hostid','pid','processid','port','endpoint','endpointuri','sessionname','tmuxsession','checkoutpath','runtimecheckoutpath','localpath','homedirectory','canonicalhome','canonicalworkspace','providerreporoot','providerconfigroot','daemoncheckout','startedat','stoppedat','lastseenat','liveness','recoverycommand','evidencepath','error']) THEN
         IF value IS DISTINCT FROM previous THEN RETURN false; END IF;
       ELSIF (jsonb_typeof(value) IN ('object','array') OR jsonb_typeof(previous) IN ('object','array')) AND NOT aun_np_json_valid(value,previous,spec) THEN RETURN false;
       END IF;
     END LOOP;
   ELSIF jsonb_typeof(n)='array' OR jsonb_typeof(o)='array' THEN
     FOR k IN SELECT generate_series(0,GREATEST(CASE WHEN jsonb_typeof(n)='array' THEN jsonb_array_length(n) ELSE 0 END,CASE WHEN jsonb_typeof(o)='array' THEN jsonb_array_length(o) ELSE 0 END)-1)::text LOOP
       IF NOT aun_np_json_valid(CASE WHEN jsonb_typeof(n)='array' THEN n->k::int ELSE NULL END,CASE WHEN jsonb_typeof(o)='array' THEN o->k::int ELSE NULL END,spec) THEN RETURN false; END IF;
     END LOOP;
   END IF;
   RETURN true;
 END IF;
 IF jsonb_typeof(n)<>'object' OR jsonb_typeof(spec)<>'object' THEN RETURN false; END IF;
 FOR k IN SELECT jsonb_object_keys(n||CASE WHEN jsonb_typeof(o)='object' THEN o ELSE '{}'::jsonb END) LOOP
   value:=n->k; previous:=o->k; t:=spec->k;
   IF t IS NULL THEN IF value IS DISTINCT FROM previous THEN RETURN false; END IF; CONTINUE; END IF;
   IF value IS NULL THEN IF jsonb_typeof(t)='object' AND jsonb_typeof(previous)='object' AND NOT aun_np_json_valid('{}'::jsonb,previous,t) THEN RETURN false; END IF; CONTINUE; END IF;
   IF value IS NOT DISTINCT FROM previous THEN CONTINUE; END IF;
   IF jsonb_typeof(t)='object' THEN
     IF NOT aun_np_json_valid(value,previous,t) THEN RETURN false; END IF;
   ELSE
     kind:=t#>>'{}';
     IF left(kind,1)='=' THEN IF value<>to_jsonb(substr(kind,2)) THEN RETURN false; END IF;
     ELSIF kind IN ('sha1','sha256') THEN IF jsonb_typeof(value)<>'string' OR NOT (value#>>'{}') ~ (CASE WHEN kind='sha1' THEN '^[0-9a-f]{40}$' ELSE '^[0-9a-f]{64}$' END) THEN RETURN false; END IF;
     ELSIF kind='uuid' THEN IF jsonb_typeof(value)<>'string' OR NOT (value#>>'{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
     ELSIF kind='bootstrap_id' THEN IF jsonb_typeof(value)<>'string' OR NOT (value#>>'{}') ~ '^bootstrap-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
     ELSIF kind='reason_code' THEN IF jsonb_typeof(value)<>'string' OR NOT (value#>>'{}') ~ '^[A-Z][A-Z0-9_]*$' THEN RETURN false; END IF;
     ELSIF kind='delivery_code' THEN IF jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN ('DELIVERY_PERMANENT_FAILURE','DELIVERY_RETRYABLE_FAILURE') THEN RETURN false; END IF;
     ELSIF kind='scopevalues' THEN IF jsonb_typeof(value)='array' THEN IF EXISTS(SELECT 1 FROM jsonb_array_elements(value) e WHERE jsonb_typeof(e) NOT IN ('string','number')) THEN RETURN false; END IF; ELSIF jsonb_typeof(value) NOT IN ('string','number') THEN RETURN false; END IF;
     ELSIF kind='strings' THEN IF jsonb_typeof(value)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(value) e WHERE jsonb_typeof(e)<>'string') THEN RETURN false; END IF;
     ELSIF NOT jsonb_typeof(value)=ANY(string_to_array(kind,'|')) THEN RETURN false;
     END IF;
   END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION aun_guard_runtime_nonpersistence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE spec jsonb:=TG_ARGV[0]::jsonb; n jsonb:=to_jsonb(NEW); o jsonb; col text; shape jsonb; event_shapes jsonb;
BEGIN
 o:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 IF TG_OP='INSERT' AND COALESCE((spec->>'deny_insert')::boolean,false) THEN RAISE EXCEPTION 'AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN:%',TG_TABLE_NAME; END IF;
 FOR col IN SELECT jsonb_array_elements_text(spec->'physical') LOOP
   IF n ? col AND ((TG_OP='INSERT' AND n->col <> 'null'::jsonb AND NOT (TG_TABLE_NAME='agents' AND col='channel_port' AND n->col='0'::jsonb)) OR (TG_OP='UPDATE' AND n->col IS DISTINCT FROM o->col)) THEN
     RAISE EXCEPTION 'AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN:%.%',TG_TABLE_NAME,col;
   END IF;
 END LOOP;
 FOR col,shape IN SELECT key,value FROM jsonb_each(spec->'json') LOOP
   IF TG_TABLE_NAME='control_plane_leases' AND col='metadata' AND NOT (n->>'lease_scope_type'='runtime_instance' AND n->>'lease_purpose'='worker') THEN shape:='"logical"'::jsonb; END IF;
   IF n ? col AND ((n->col<>'null'::jsonb AND jsonb_typeof(n->col)<>'object') OR NOT aun_np_json_valid(NULLIF(n->col,'null'::jsonb),NULLIF(o->col,'null'::jsonb),shape)) THEN RAISE EXCEPTION 'AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN:%.%',TG_TABLE_NAME,col; END IF;
 END LOOP;
 FOR col,shape IN SELECT key,value FROM jsonb_each(COALESCE(spec->'values','{}'::jsonb)) LOOP
   IF n->col IS DISTINCT FROM o->col AND n->col <> 'null'::jsonb THEN
     IF jsonb_typeof(n->col)<>'string' OR NOT (n->>col) ~
       (CASE WHEN shape='"sha1"'::jsonb THEN '^[0-9a-f]{40}$' ELSE '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$' END) THEN
       RAISE EXCEPTION 'AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN:%.%',TG_TABLE_NAME,col;
     END IF;
   END IF;
 END LOOP;
 event_shapes:=spec->'events'->(n->>'event_type');
 IF event_shapes IS NOT NULL THEN
   FOR col,shape IN SELECT key,value FROM jsonb_each(event_shapes) LOOP
     IF NOT aun_np_json_valid(NULLIF(n->col,'null'::jsonb),NULLIF(o->col,'null'::jsonb),shape) THEN RAISE EXCEPTION 'AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN:%.%',TG_TABLE_NAME,col; END IF;
   END LOOP;
 END IF;
 IF TG_TABLE_NAME='audit_log' AND n->>'event_type' IN ('runtime.cleanup_target','runtime.cleanup_execute') AND n->>'target' ~ '^(listener|tmux):' AND n->'target' IS DISTINCT FROM o->'target' THEN
   RAISE EXCEPTION 'AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN:audit.target';
 END IF;
 RETURN NEW;
END $$;
DO $$
DECLARE v_table text; col text; shape jsonb; specs jsonb:='{"agent_runtime_instances":{"physical":["runtime_engine","host_id","session_name","process_id","port","checkout_path","endpoint_uri","status","started_at","stopped_at","last_seen_at"],"json":{"metadata":{"schema_version":"=aun-runtime-nonpersistence/v1","bootstrap_run_id":"bootstrap_id","mcp_runtime_instance_id":"uuid","source_commit":"sha1","source_tree":"sha1"}}},"runtime_memory_ready_evidence":{"physical":["session_name","port","checkout_path","recovery_command","evidence_path"],"json":{"metadata":{"schema_version":"=aun-runtime-nonpersistence/v1","seat_context_proof":{"agent_id":"string","project":"string","runtime_instance_id":"uuid","pack_id":"string","work_digest":"sha256","invocation_digest":"sha256","completed_at":"string"},"actor":"string","reason":"string","timestamp":"string","target_agent":"string","target_agent_id":"string","expires_at":"string","expiry":"string","expiry_at":"string","queue_scope":{"queue_id":"scopevalues","queue_ids":"scopevalues","status":"scopevalues","statuses":"scopevalues","action_kind":"scopevalues","action_kinds":"scopevalues","agent_id":"string","target_agent":"string","target_agent_id":"string"},"bootstrap_run_id":"bootstrap_id","target":{"agent_id":"string"}}},"values":{"source":"identifier","failure_reason":"identifier","evidence_log_id":"identifier","checkout_commit_sha":"sha1"}},"control_plane_leases":{"physical":[],"json":{"metadata":{"schema_version":"=aun-runtime-nonpersistence/v1"}}},"agents":{"physical":["runtime","cli_type","status","status_detail","status_updated_at","last_seen_at","heartbeat_at","channel_port","home_directory","runtime_engine_preference","canonical_home","canonical_workspace"],"json":{"metadata":"logical","ordinary_projection":"logical"}},"agent_workspaces":{"physical":["local_path"],"json":{"metadata":"logical"}},"connector_instances":{"physical":["last_seen_at"],"json":{"metadata":"logical"}},"agent_endpoints":{"physical":["endpoint_uri"],"json":{"metadata":"logical"}},"aun_configuration_observed_state":{"physical":["host_id","runtime_identity_digest","candidate_digest","provider_native_digest","launchagent_plist_digest","launchctl_environment_digest","observed_at"],"json":{},"deny_insert":true},"aun_configuration_restart_requests":{"physical":["host_id","candidate_digest","rollback_artifact_digest"],"json":{},"deny_insert":true},"audit_log":{"physical":[],"json":{},"events":{"runtime.memory_ready_identity":{"detail":{"code":"reason_code"}},"runtime.cleanup_target":{"detail":{"dry_run":"boolean","classification":"string","risk":"string","runtime_instance_id":"string|null","action_kinds":"strings"}},"runtime.cleanup_execute":{"detail":{"executable_actions":"number","cleanup_targets":"number","unknown_risk_targets":"number"}},"runtime.memory_ready":{"detail":{"project":"string|number","runtime_instance_id":"string|number","result_status":"string|number","source":"string|number","evidence_id":"string|number","evidence_log_id":"string|number|null"}}}},"event_log":{"physical":[],"json":{},"events":{"reply.failed":{"payload":{"kind":"string","code":"delivery_code"}}}}}'::jsonb;
BEGIN
 FOR v_table,shape IN SELECT key,value FROM jsonb_each(specs) LOOP
   IF to_regclass(v_table) IS NULL THEN CONTINUE; END IF;
   FOR col IN SELECT jsonb_array_elements_text(shape->'physical') LOOP
     IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema=current_schema() AND c.table_name=v_table AND c.column_name=col) AND NOT (v_table IN ('aun_configuration_observed_state','aun_configuration_restart_requests') AND col='host_id') THEN
       EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL',v_table,col);
       EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT',v_table,col);
     END IF;
   END LOOP;
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(v_table) AND tgname='zz_aun_runtime_nonpersistence' AND NOT tgisinternal) THEN
     EXECUTE format('CREATE TRIGGER zz_aun_runtime_nonpersistence AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION aun_guard_runtime_nonpersistence(%L)',v_table,shape::text);
   END IF;
 END LOOP;
END $$;
COMMIT;
