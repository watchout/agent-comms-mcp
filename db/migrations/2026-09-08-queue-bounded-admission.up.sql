-- Opt-in only: installing the library does not protect a recipient. PREPARE
-- atomically installs policy-pinned triggers and first deny. No live grants.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aun_admission_owner') THEN
    CREATE ROLE aun_admission_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aun_admission_control') THEN
    CREATE ROLE aun_admission_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aun_admission_executor') THEN
    CREATE ROLE aun_admission_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aun_admission_runtime') THEN
    CREATE ROLE aun_admission_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.queue_admission_policies (
  policy_id text PRIMARY KEY,
  agent_id text NOT NULL UNIQUE,
  config jsonb NOT NULL,
  config_digest text NOT NULL CHECK (config_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('PREPARED','ENABLED','HALTED','CLOSED')),
  revision bigint NOT NULL DEFAULT 1,
  halt_code text,
  notice_reserved boolean NOT NULL DEFAULT false,
  notice_queue_id bigint REFERENCES public.message_queue(id),
  notice_deliveries jsonb NOT NULL DEFAULT '[]'::jsonb,
  bot_not_before jsonb NOT NULL DEFAULT '{}'::jsonb,
  operation jsonb,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (config->>'max_tasks' = '2' AND config->>'max_inflight' = '1'
    AND config->>'invocation_max_attempts' = '1' AND config->>'finalizer_max_attempts' = '1'),
  CHECK (jsonb_typeof(config->'task_definitions') = 'array'
    AND jsonb_array_length(config->'task_definitions') = 2)
);
ALTER TABLE public.queue_admission_policies ADD COLUMN IF NOT EXISTS notice_queue_id bigint REFERENCES public.message_queue(id);
ALTER TABLE public.queue_admission_policies ADD COLUMN IF NOT EXISTS notice_deliveries jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.queue_admission_policies ADD COLUMN IF NOT EXISTS bot_not_before jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS public.queue_admission_tasks (
  policy_id text NOT NULL REFERENCES public.queue_admission_policies(policy_id),
  ordinal smallint NOT NULL CHECK (ordinal IN (1,2)),
  queue_id bigint NOT NULL UNIQUE REFERENCES public.message_queue(id),
  message_id text NOT NULL UNIQUE,
  binding jsonb NOT NULL,
  stage text NOT NULL CHECK (stage IN ('ENROLLED','INVOKING','RESULT_SAVED','FINALIZING','REPLIED','ACCEPTED','HALTED')),
  invocation_attempts smallint NOT NULL DEFAULT 0 CHECK (invocation_attempts IN (0,1)),
  finalizer_attempts smallint NOT NULL DEFAULT 0 CHECK (finalizer_attempts IN (0,1)),
  claim_fence jsonb,
  result_digest text,
  reply_id text UNIQUE,
  acceptance jsonb,
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  PRIMARY KEY (policy_id,ordinal)
);
ALTER TABLE public.queue_admission_policies OWNER TO aun_admission_owner;
ALTER TABLE public.queue_admission_tasks OWNER TO aun_admission_owner;
REVOKE ALL ON public.queue_admission_policies, public.queue_admission_tasks FROM PUBLIC;
REVOKE ALL ON public.queue_admission_policies, public.queue_admission_tasks FROM aun_admission_runtime, aun_admission_executor, aun_admission_control;
GRANT USAGE ON SCHEMA public TO aun_admission_owner, aun_admission_runtime, aun_admission_executor, aun_admission_control;
GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER ON public.agent_messages, public.message_queue, public.outbound_queue TO aun_admission_owner;
GRANT USAGE, SELECT ON SEQUENCE public.message_queue_id_seq, public.outbound_queue_id_seq TO aun_admission_owner;

-- The existing observation-v2 AFTER trigger is SECURITY INVOKER: guarded queue
-- updates use this fixed owner, not the caller's legacy transport grants.
DO $$
DECLARE
  epoch_sequence regclass := to_regclass('public.fleet_runtime_queue_observation_epoch_seq');
  active_table regclass := to_regclass('public.fleet_runtime_queue_observation_active');
  revision_table regclass := to_regclass('public.fleet_runtime_queue_agent_revisions');
  bump_function regprocedure := to_regprocedure('public.fleet_runtime_bump_queue_agent_revision_v2()');
  queue_trigger oid;
BEGIN
  SELECT oid INTO queue_trigger FROM pg_trigger
    WHERE tgrelid='public.message_queue'::regclass AND tgname='fleet_runtime_queue_agent_revision_v2' AND NOT tgisinternal;
  IF epoch_sequence IS NULL AND active_table IS NULL AND revision_table IS NULL
    AND bump_function IS NULL AND queue_trigger IS NULL THEN RETURN; END IF;
  IF epoch_sequence IS NULL OR active_table IS NULL OR revision_table IS NULL
    OR bump_function IS NULL OR queue_trigger IS NULL
    OR NOT EXISTS(SELECT FROM pg_class WHERE oid=epoch_sequence AND relkind='S')
    OR NOT EXISTS(SELECT FROM pg_class WHERE oid=active_table AND relkind='r')
    OR NOT EXISTS(SELECT FROM pg_class WHERE oid=revision_table AND relkind='r')
    OR NOT EXISTS(SELECT FROM pg_proc WHERE oid=bump_function AND NOT prosecdef AND prorettype='trigger'::regtype)
    OR NOT EXISTS(SELECT FROM pg_trigger WHERE oid=queue_trigger AND tgfoid=bump_function
      AND tgtype=29 AND tgenabled IN ('O','A') AND tgnargs=0) THEN
    RAISE EXCEPTION 'ADMISSION_OBSERVATION_TOPOLOGY_INVALID';
  END IF;
  IF (SELECT count(*) FROM public.fleet_runtime_queue_observation_active
    WHERE singleton=true AND schema_version='fleet-runtime-v1/observation/v2'
      AND contract_revision=2 AND migration_epoch>0) <> 1 THEN
    RAISE EXCEPTION 'ADMISSION_OBSERVATION_TOPOLOGY_INVALID';
  END IF;
  -- Resolve the actual trigger's required columns before granting dependencies.
  PERFORM migration_epoch,agent_id,revision,updated_at FROM public.fleet_runtime_queue_agent_revisions LIMIT 0;
  GRANT SELECT ON public.fleet_runtime_queue_observation_active TO aun_admission_owner;
  GRANT SELECT,INSERT,UPDATE ON public.fleet_runtime_queue_agent_revisions TO aun_admission_owner;
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_digest(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public
AS $$ SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') $$;

CREATE OR REPLACE FUNCTION public.aun_admission_principal() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT COALESCE(NULLIF(current_setting('role',true),'none'),session_user::text) $$;

CREATE OR REPLACE FUNCTION public.aun_admission_capability() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('revision','2026-09-08.v1','postgres_version',current_setting('server_version_num')::integer,
    'guard_digest',encode(sha256(convert_to(string_agg(
      p.oid::regprocedure::text||E'\n'||pg_get_functiondef(p.oid)||E'\n'||r.rolname||E'\n'||COALESCE(p.proacl::text,''),
      E'\n' ORDER BY p.oid::regprocedure::text),'UTF8')),'hex'))
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'aun_admission_%'
$$;

CREATE OR REPLACE FUNCTION public.aun_admission_assert_principal(config jsonb, kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE who text := public.aun_admission_principal();
BEGIN
  IF kind NOT IN ('controller','executor','runtime') OR
     who IS DISTINCT FROM config->'roles'->>kind OR
     NOT pg_has_role(who, CASE kind WHEN 'controller' THEN 'aun_admission_control'
       WHEN 'executor' THEN 'aun_admission_executor' ELSE 'aun_admission_runtime' END,'MEMBER') THEN
    RAISE EXCEPTION 'ADMISSION_PRINCIPAL_MISMATCH' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname=who AND (rolsuper OR rolcreaterole OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ADMISSION_PRIVILEGED_CALLER' USING ERRCODE='42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_lock(pid text, live boolean DEFAULT true)
RETURNS public.queue_admission_policies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.queue_admission_policies;
BEGIN
  SELECT * INTO p FROM public.queue_admission_policies WHERE policy_id=pid FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_POLICY_NOT_VISIBLE'; END IF;
  IF p.config_digest <> public.aun_admission_digest(p.config) THEN RAISE EXCEPTION 'ADMISSION_CONFIG_DRIFT'; END IF;
  IF p.config->>'guard_digest' IS DISTINCT FROM public.aun_admission_capability()->>'guard_digest' THEN RAISE EXCEPTION 'ADMISSION_GUARD_DRIFT'; END IF;
  IF live AND (p.status <> 'ENABLED' OR p.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'ADMISSION_DENIED';
  END IF;
  RETURN p;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'ADMISSION_BUSY' USING ERRCODE='55P03';
END $$;

-- No caller-set GUC/JSON token is an execution permit. Only inaccessible core
-- functions can persist this exact, transaction/backend-bound expected row.
CREATE OR REPLACE FUNCTION public.aun_admission_permit(pid text, tbl text, oldrow jsonb, newrow jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.queue_admission_policies SET operation=jsonb_build_object(
    'tx',txid_current()::text,'backend',pg_backend_pid(),'table',tbl,'old',oldrow,'new',newrow)
    WHERE policy_id=pid;
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_queue_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.queue_admission_policies; before_row jsonb; after_row jsonb;
BEGIN
  before_row := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after_row := CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  IF COALESCE(before_row->>'agent_id','') <> TG_ARGV[0]
     AND COALESCE(after_row->>'agent_id','') <> TG_ARGV[0] THEN RETURN COALESCE(NEW,OLD); END IF;
  p := public.aun_admission_lock(TG_ARGV[1],false);
  IF TG_OP='INSERT' AND NEW.agent_id=TG_ARGV[0] AND NEW.status='pending'
     AND NEW.claimed_by IS NULL AND NEW.claimed_at IS NULL AND NEW.claim_expires_at IS NULL
     AND NEW.message_id IS NOT NULL AND p.status IN ('PREPARED','ENABLED')
     AND p.expires_at>clock_timestamp() THEN RETURN NEW; END IF;
  IF p.operation IS NOT NULL
     AND p.operation->>'tx'=txid_current()::text
     AND p.operation->>'backend'=pg_backend_pid()::text
     AND p.operation->>'table'=TG_TABLE_NAME
     AND p.operation->'old' IS NOT DISTINCT FROM COALESCE(before_row,'null'::jsonb)
     AND p.operation->'new' IS NOT DISTINCT FROM COALESCE(after_row,'null'::jsonb) THEN
    UPDATE public.queue_admission_policies SET operation=NULL WHERE policy_id=p.policy_id;
    RETURN COALESCE(NEW,OLD);
  END IF;
  RAISE EXCEPTION 'ADMISSION_DIRECT_QUEUE_WRITE_DENIED' USING ERRCODE='42501';
END $$;

-- Correlation is recipient/parent based, never sender or outbound consumer.
CREATE OR REPLACE FUNCTION public.aun_admission_correlation(mid text, agent text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.agent_messages; q public.message_queue; parent public.message_queue; expected boolean;
BEGIN
  SELECT * INTO m FROM public.agent_messages WHERE id::text=mid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  expected := COALESCE(m.metadata->'mentions' ? agent,false)
    OR COALESCE(m.metadata->'aun_control_plane'->>'active_owner'=agent,false)
    OR COALESCE(agent=ANY(m.input_mentions),false);
  SELECT * INTO q FROM public.message_queue WHERE message_id=mid AND agent_id=agent;
  IF m.reply_to IS NOT NULL THEN
    SELECT * INTO parent FROM public.message_queue WHERE message_id=m.reply_to::text AND agent_id=agent;
  END IF;
  IF parent.id IS NOT NULL AND (q.id IS NOT NULL OR expected) THEN RAISE EXCEPTION 'ADMISSION_CORRELATION_AMBIGUOUS'; END IF;
  IF parent.id IS NOT NULL THEN RETURN jsonb_build_object('kind','reply','original_message_id',parent.message_id,'original_queue_id',parent.id); END IF;
  IF q.id IS NOT NULL THEN RETURN jsonb_build_object('kind','original','original_message_id',mid,'original_queue_id',q.id); END IF;
  IF expected THEN RETURN jsonb_build_object('kind','missing_fanout','original_message_id',mid); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_transport_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.queue_admission_policies; c jsonb; oldc jsonb; oldrow jsonb; newrow jsonb; mid text;
BEGIN
  oldrow := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  newrow := CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  mid := CASE WHEN TG_TABLE_NAME='agent_messages' THEN COALESCE(newrow->>'id',oldrow->>'id')
    ELSE COALESCE(newrow->>'message_id',oldrow->>'message_id') END;
  c := public.aun_admission_correlation(mid,TG_ARGV[0]);
  IF TG_TABLE_NAME='agent_messages' THEN
    IF COALESCE(newrow->'metadata'->'mentions' ? TG_ARGV[0],false)
       OR newrow->'metadata'->'aun_control_plane'->>'active_owner'=TG_ARGV[0]
       OR COALESCE(newrow->'input_mentions' ? TG_ARGV[0],false)
       OR EXISTS(SELECT FROM public.message_queue WHERE message_id=newrow->>'reply_to' AND agent_id=TG_ARGV[0]) THEN
      c := COALESCE(c,'{}'::jsonb);
    END IF;
    IF TG_OP<>'INSERT' AND c IS NOT NULL THEN
      p := public.aun_admission_lock(TG_ARGV[1],false);
      IF p.operation IS NOT NULL AND p.operation->>'tx'=txid_current()::text
        AND p.operation->>'backend'=pg_backend_pid()::text AND p.operation->>'table'=TG_TABLE_NAME
        AND p.operation->'old' IS NOT DISTINCT FROM COALESCE(oldrow,'null'::jsonb)
        AND p.operation->'new' IS NOT DISTINCT FROM COALESCE(newrow,'null'::jsonb) THEN
        UPDATE public.queue_admission_policies SET operation=NULL WHERE policy_id=p.policy_id;
        RETURN COALESCE(NEW,OLD);
      END IF;
      -- Original content/metadata/recipient identity is immutable after send.
      IF TG_OP='DELETE' OR (oldrow IS DISTINCT FROM newrow AND NOT EXISTS(
        SELECT FROM public.agent_messages am WHERE am.id::text=mid AND am.xmin::text=txid_current()::text)) THEN
        RAISE EXCEPTION 'ADMISSION_MESSAGE_IMMUTABLE' USING ERRCODE='42501';
      END IF;
    END IF;
  ELSE
    IF oldrow IS NOT NULL THEN
      SELECT value INTO oldc FROM jsonb_array_elements(COALESCE(oldrow->'delivery_diagnostics','[]'))
        WHERE value->>'code'='AUN_BOUNDED_ADMISSION' AND value->>'policy_id'=TG_ARGV[1];
    END IF;
    c := COALESCE(c,oldc);
  END IF;
  IF c IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
  p := public.aun_admission_lock(TG_ARGV[1],false);
  IF TG_OP='INSERT' THEN
    IF p.status NOT IN ('PREPARED','ENABLED') OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ADMISSION_DENIED'; END IF;
    IF TG_TABLE_NAME='outbound_queue' AND (newrow->>'status'<>'pending' OR newrow->>'attempts'<>'0') THEN RAISE EXCEPTION 'ADMISSION_INITIAL_PROJECTION_INVALID'; END IF;
    RETURN NEW; -- Commit-time check owns classification after all fanout inserts.
  END IF;
  IF TG_TABLE_NAME='agent_messages' THEN RETURN NEW; END IF;
  IF p.operation IS NOT NULL AND p.operation->>'tx'=txid_current()::text
    AND p.operation->>'backend'=pg_backend_pid()::text AND p.operation->>'table'=TG_TABLE_NAME
    AND p.operation->'old' IS NOT DISTINCT FROM COALESCE(oldrow,'null'::jsonb)
    AND p.operation->'new' IS NOT DISTINCT FROM COALESCE(newrow,'null'::jsonb) THEN
    UPDATE public.queue_admission_policies SET operation=NULL WHERE policy_id=p.policy_id;
    RETURN COALESCE(NEW,OLD);
  END IF;
  RAISE EXCEPTION 'ADMISSION_DIRECT_PROJECTION_WRITE_DENIED' USING ERRCODE='42501';
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_classify(mid text, agent text, pid text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.queue_admission_policies; c jsonb; diag jsonb; o public.outbound_queue; n public.outbound_queue; t public.queue_admission_tasks;
BEGIN
  c := public.aun_admission_correlation(mid,agent);
  IF c IS NULL THEN RETURN; END IF;
  p := public.aun_admission_lock(pid,false);
  IF c->>'kind'='missing_fanout' THEN RAISE EXCEPTION 'ADMISSION_REQUIRED_FANOUT_MISSING'; END IF;
  IF c->>'kind'='reply' THEN
    SELECT * INTO t FROM public.queue_admission_tasks WHERE policy_id=pid AND queue_id=(c->>'original_queue_id')::bigint;
    IF NOT FOUND OR t.stage<>'REPLIED' OR t.reply_id<>mid THEN RAISE EXCEPTION 'ADMISSION_REPLY_NOT_COMMITTED'; END IF;
  END IF;
  diag := c || jsonb_build_object('code','AUN_BOUNDED_ADMISSION','policy_id',pid,'config_digest',p.config_digest,
    'gate',CASE c->>'kind' WHEN 'original' THEN 'HOLD_ENROLL' ELSE 'HOLD_REPLY_COMMIT' END);
  FOR o IN SELECT * FROM public.outbound_queue WHERE message_id=mid FOR UPDATE NOWAIT LOOP
    IF jsonb_typeof(o.delivery_diagnostics)<>'array' THEN RAISE EXCEPTION 'ADMISSION_DIAGNOSTICS_INVALID'; END IF;
    IF o.delivery_diagnostics @> jsonb_build_array(diag) THEN CONTINUE; END IF;
    IF EXISTS(SELECT FROM jsonb_array_elements(o.delivery_diagnostics) d WHERE d->>'code'='AUN_BOUNDED_ADMISSION') THEN
      RAISE EXCEPTION 'ADMISSION_CORRELATION_AMBIGUOUS';
    END IF;
    -- Never retag pre-PREPARE historical rows or reset a consumed attempt.
    IF o.created_at < p.installed_at OR o.status<>'pending' OR o.attempts<>0 THEN RAISE EXCEPTION 'ADMISSION_PREEXISTING_ROW'; END IF;
    n := o; n.delivery_diagnostics := o.delivery_diagnostics || jsonb_build_array(diag);
    n.max_attempts := CASE c->>'kind' WHEN 'reply' THEN 3 ELSE 1 END;
    PERFORM public.aun_admission_permit(pid,'outbound_queue',to_jsonb(o),to_jsonb(n));
    UPDATE public.outbound_queue SET delivery_diagnostics=n.delivery_diagnostics,max_attempts=n.max_attempts WHERE id=o.id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_commit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE mid text;
BEGIN
  mid := CASE WHEN TG_TABLE_NAME='agent_messages' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'message_id' END;
  PERFORM public.aun_admission_classify(mid,TG_ARGV[0],TG_ARGV[1]);
  RETURN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS aun_admission_unique_projection ON public.outbound_queue(message_id)
WHERE delivery_diagnostics @> '[{"code":"AUN_BOUNDED_ADMISSION"}]'::jsonb;

CREATE OR REPLACE FUNCTION public.aun_admission_prepare_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('transaction_timeout',true) IS NULL THEN RAISE EXCEPTION 'ADMISSION_STORAGE_UNSUPPORTED'; END IF;
  IF current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_timeout')::interval<>interval '1 second' THEN RAISE EXCEPTION 'ADMISSION_PREPARE_DEADLINE_REQUIRED'; END IF;
  LOCK TABLE public.agent_messages, public.message_queue, public.outbound_queue IN SHARE ROW EXCLUSIVE MODE NOWAIT;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'ADMISSION_PREPARE_BUSY' USING ERRCODE='55P03';
END $$;

-- Called as a SEPARATE statement after the caller acquired all three locks.
-- Original gen5 first-deny excludes only proven completed history. A done flag
-- or caller-controlled no_op alone is insufficient. This helper is read-only,
-- runs under the same three-table lock and has the same private owner/ACL fence.
CREATE OR REPLACE FUNCTION public.aun_admission_completed_history(q public.message_queue) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p jsonb; b jsonb; m public.agent_messages; n jsonb; stamp timestamptz;
BEGIN
  IF q.status IS DISTINCT FROM 'done' OR q.created_at IS NULL OR q.done_at IS NULL
    OR NOT isfinite(q.created_at) OR NOT isfinite(q.done_at) OR q.done_at>clock_timestamp()
    OR q.done_at<q.created_at OR q.failed_reason IS NOT NULL
    OR q.replied_with IS NOT NULL OR q.replied_at IS NOT NULL THEN RETURN false; END IF;
  p:=q.payload::jsonb;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR p ?| ARRAY['runner_result','runner_error','finalizer_error','queue_work_execution','writeback_result','shirube_d1','shirube_d1_invocation']
    OR EXISTS(SELECT FROM public.agent_messages r WHERE r.reply_to::text=q.message_id)
    OR EXISTS(SELECT FROM public.outbound_queue o WHERE o.message_id=q.message_id AND o.status NOT IN ('sent','skipped')) THEN RETURN false; END IF;
  IF p->>'schema_version'='aun-n1-slo-probe/v1' THEN
    SELECT * INTO m FROM public.agent_messages WHERE id::text=q.message_id;
    n:=m.metadata->'n1_slo';
    IF NOT FOUND OR q.claimed_by IS NOT NULL OR q.claimed_at IS NOT NULL OR q.claim_expires_at IS NOT NULL
      OR jsonb_typeof(n) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'run_id') IS DISTINCT FROM 'string' OR NULLIF(p->>'run_id','') IS NULL
      OR p->>'message_type' IS DISTINCT FROM 'probe' OR p->'no_op' IS DISTINCT FROM 'true'::jsonb
      OR p->>'from' IS DISTINCT FROM q.agent_id OR p->>'to' IS DISTINCT FROM q.agent_id
      OR p->>'content' IS DISTINCT FROM '[AUN-N1-SLO-PROBE/v1]:'||(p->>'run_id')||':'||q.agent_id
      OR m.message_type IS DISTINCT FROM 'probe' OR m.author_id IS DISTINCT FROM q.agent_id OR m.channel_id IS DISTINCT FROM 'pdca-daily'
      OR m.content IS DISTINCT FROM p->>'content' OR m.direction IS DISTINCT FROM 'internal'
      OR n->>'schema_version' IS DISTINCT FROM p->>'schema_version' OR n->>'run_id' IS DISTINCT FROM p->>'run_id'
      OR n->>'agent_id' IS DISTINCT FROM q.agent_id OR n->>'outcome' IS DISTINCT FROM 'success'
      OR n->'provider_effect_count' IS DISTINCT FROM '0'::jsonb OR n->'discord_visible_send_count' IS DISTINCT FROM '0'::jsonb
      OR n->'failure_type' IS DISTINCT FROM 'null'::jsonb OR n->'failure_stage' IS DISTINCT FROM 'null'::jsonb
      OR jsonb_typeof(n->'sent_at') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'claimed_at') IS DISTINCT FROM 'string'
      OR jsonb_typeof(n->'closed_at') IS DISTINCT FROM 'string'
      OR abs(extract(epoch FROM ((n->>'closed_at')::timestamptz-q.done_at)))>=0.001
      OR abs(extract(epoch FROM ((n->>'sent_at')::timestamptz-m.created_at)))>=0.001
      OR (n->>'claimed_at')::timestamptz<(n->>'sent_at')::timestamptz
      OR (n->>'claimed_at')::timestamptz>(n->>'closed_at')::timestamptz
      OR EXISTS(SELECT FROM public.outbound_queue o WHERE o.message_id=q.message_id) THEN RETURN false; END IF;
    RETURN true;
  END IF;
  b:=p->'terminal_baton';
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR b->'no_reply_required' IS DISTINCT FROM 'true'::jsonb
    OR b->>'set_by' IS DISTINCT FROM q.agent_id OR jsonb_typeof(b->'reason') IS DISTINCT FROM 'string' OR NULLIF(b->>'reason','') IS NULL
    OR b->>'source' IS DISTINCT FROM 'record_no_reply_command'
    OR jsonb_typeof(b->'set_at') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  stamp:=(b->>'set_at')::timestamptz;
  -- Lifecycle stamps JS time after BEGIN while done_at=now() is transaction start.
  IF stamp<q.created_at OR stamp>clock_timestamp() OR NOT isfinite(stamp)
    OR ((q.claimed_by IS NULL AND q.claimed_at IS NULL AND q.claim_expires_at IS NULL)
      OR (q.claimed_by=q.agent_id AND q.claimed_at IS NOT NULL AND q.claim_expires_at IS NOT NULL
        AND q.claimed_at<=q.done_at AND q.claimed_at<=stamp AND q.claim_expires_at>=q.claimed_at)) IS DISTINCT FROM true THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; -- malformed/unknown historical bytes remain blocked
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_prepare(config jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pid text:=config->>'policy_id'; agent text:=config->>'agent_id'; tbl text; stem text; expiry timestamptz; role_name text;
BEGIN
  IF current_setting('transaction_timeout',true) IS NULL THEN RAISE EXCEPTION 'ADMISSION_STORAGE_UNSUPPORTED'; END IF;
  IF current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_timeout')::interval>interval '1 second'
    OR current_setting('transaction_timeout')::interval<=interval '0 second' THEN RAISE EXCEPTION 'ADMISSION_PREPARE_DEADLINE_REQUIRED'; END IF;
  PERFORM public.aun_admission_assert_principal(config,'controller');
  IF config->>'max_tasks' IS DISTINCT FROM '2' OR config->>'max_inflight' IS DISTINCT FROM '1'
    OR config->>'invocation_max_attempts' IS DISTINCT FROM '1' OR config->>'finalizer_max_attempts' IS DISTINCT FROM '1'
    OR COALESCE(config->>'source_sha','')!~'^[0-9a-f]{40}$' OR COALESCE(config->>'cohort_digest','')!~'^[0-9a-f]{64}$'
    OR NULLIF(config->>'runtime_id','') IS NULL OR NULLIF(config->>'maker','') IS NULL OR NULLIF(config->>'checker','') IS NULL
    OR config->>'maker'=config->>'checker' OR COALESCE((config->>'worker_timeout_seconds')::integer,0)<=0
    OR jsonb_typeof(config->'task_definitions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(config->'task_definitions')<>2 THEN RAISE EXCEPTION 'ADMISSION_CONFIG_INVALID'; END IF;
  IF jsonb_typeof(config->'transport') IS DISTINCT FROM 'object'
    OR config->'transport'->>'original_max_posts' IS DISTINCT FROM '1'
    OR config->'transport'->>'reply_max_posts' IS DISTINCT FROM '3'
    OR config->'transport'->'waits_ms' IS DISTINCT FROM '[10000,30000]'::jsonb
    OR config->'transport'->>'post_timeout_ms' IS DISTINCT FROM '10000'
    OR config->'transport'->>'transport_horizon_ms' IS DISTINCT FROM '120000'
    OR config->'transport'->>'persistence_max_writes' IS DISTINCT FROM '5'
    OR config->'transport'->>'persistence_window_ms' IS DISTINCT FROM '20000'
    OR COALESCE(config->'transport'->>'receipt_dir','')!~'^/[^\n]+$'
    OR NULLIF(config->'transport'->>'host','') IS NULL THEN RAISE EXCEPTION 'ADMISSION_TRANSPORT_CONFIG_INVALID'; END IF;
  IF pid IS NULL OR pid!~'^[A-Za-z0-9_-]{1,120}$' OR agent IS NULL OR agent!~'^[A-Za-z0-9_-]{1,80}$' THEN RAISE EXCEPTION 'ADMISSION_CONFIG_INVALID'; END IF;
  IF config->>'guard_digest' IS DISTINCT FROM public.aun_admission_capability()->>'guard_digest' THEN RAISE EXCEPTION 'ADMISSION_GUARD_DRIFT'; END IF;
  IF jsonb_typeof(config->'roles')<>'object' OR (SELECT count(DISTINCT value) FROM jsonb_each_text(config->'roles'))<>3 THEN RAISE EXCEPTION 'ADMISSION_ROLES_NOT_DISTINCT'; END IF;
  FOR role_name IN SELECT value FROM jsonb_each_text(config->'roles') LOOP
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=role_name AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls) THEN RAISE EXCEPTION 'ADMISSION_ROLE_UNSAFE'; END IF;
  END LOOP;
  expiry := (config->>'expires_at')::timestamptz;
  IF expiry IS NULL OR expiry<=clock_timestamp() THEN RAISE EXCEPTION 'ADMISSION_EXPIRED'; END IF;
  -- Verify caller already obtained these locks in its preceding RC statement.
  IF (SELECT count(*) FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.granted AND l.mode='ShareRowExclusiveLock'
      AND l.relation IN ('public.agent_messages'::regclass,'public.message_queue'::regclass,'public.outbound_queue'::regclass))<>3 THEN
    RAISE EXCEPTION 'ADMISSION_PREPARE_LOCKS_REQUIRED';
  END IF;
  IF EXISTS(SELECT FROM public.message_queue q WHERE q.agent_id=agent AND
       (q.status IN ('received','in_progress','read')
        OR ((q.status='done' OR q.claimed_by IS NOT NULL OR q.claimed_at IS NOT NULL OR q.claim_expires_at IS NOT NULL)
          AND NOT public.aun_admission_completed_history(q))))
    OR EXISTS(SELECT FROM public.outbound_queue o WHERE o.status='claimed' AND public.aun_admission_correlation(o.message_id,agent) IS NOT NULL) THEN
    RAISE EXCEPTION 'ADMISSION_AFFECTED_WORK_PRESENT';
  END IF;
  INSERT INTO public.queue_admission_policies(policy_id,agent_id,config,config_digest,expires_at,status)
    VALUES(pid,agent,config,public.aun_admission_digest(config),expiry,'PREPARED');
  stem := 'aun_ba_' || substr(public.aun_admission_digest(to_jsonb(pid)),1,20);
  FOREACH tbl IN ARRAY ARRAY['agent_messages','message_queue','outbound_queue'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I(%L,%L)',
      stem||'_guard',tbl,CASE tbl WHEN 'message_queue' THEN 'aun_admission_queue_guard' ELSE 'aun_admission_transport_guard' END,agent,pid);
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.aun_admission_commit_guard(%L,%L)',
      stem||'_commit',tbl,agent,pid);
  END LOOP;
  RETURN jsonb_build_object('policy_id',pid,'config_digest',public.aun_admission_digest(config),'status','PREPARED','revision',1,'trigger_stem',stem);
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_status(pid text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('policy',to_jsonb(p)-'operation','tasks',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY ordinal)
    FROM public.queue_admission_tasks t WHERE t.policy_id=p.policy_id),'[]'::jsonb))
  FROM public.queue_admission_policies p WHERE p.policy_id=pid
$$;

CREATE OR REPLACE FUNCTION public.aun_admission_agent_status(agent text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.aun_admission_status(policy_id) FROM public.queue_admission_policies WHERE agent_id=agent
$$;

-- Common transition entrypoint. The caller supplies expected state, never a
-- reusable mutation permit. The core constructs and consumes exact NEW rows.
CREATE OR REPLACE FUNCTION public.aun_admission_transition(pid text, expected_revision bigint,
  expected_digest text, action text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.queue_admission_policies; t public.queue_admission_tasks; q public.message_queue; n public.message_queue;
  m public.agent_messages; def jsonb; ord integer; fence jsonb; v_result jsonb; stamp timestamptz:=clock_timestamp();
BEGIN
  p := public.aun_admission_lock(pid,false);
  IF expected_revision IS DISTINCT FROM p.revision OR expected_digest IS DISTINCT FROM p.config_digest THEN RAISE EXCEPTION 'ADMISSION_STALE_STATE'; END IF;
  IF action IN ('enroll','enable','accept','halt') THEN
    PERFORM public.aun_admission_assert_principal(p.config,'controller');
  ELSE
    PERFORM public.aun_admission_assert_principal(p.config,'executor');
  END IF;
  IF action IN ('halt','failure') THEN
    IF NULLIF(input->>'reason','') IS NULL THEN RAISE EXCEPTION 'ADMISSION_REASON_REQUIRED'; END IF;
    UPDATE public.queue_admission_policies SET status=CASE WHEN status='CLOSED' THEN 'CLOSED' ELSE 'HALTED' END,
      halt_code=COALESCE(halt_code,input->>'reason'),notice_reserved=true,revision=revision+1 WHERE policy_id=pid;
    RETURN public.aun_admission_status(pid);
  END IF;
  -- Result evidence may be retained after expiry; it cannot authorize another effect.
  IF action<>'result' AND (p.expires_at<=stamp OR p.status IN ('HALTED','CLOSED')) THEN RAISE EXCEPTION 'ADMISSION_DENIED'; END IF;
  IF action='enable' THEN
    IF p.status<>'PREPARED' OR NOT EXISTS(SELECT FROM public.queue_admission_tasks WHERE policy_id=pid AND ordinal=1) THEN RAISE EXCEPTION 'ADMISSION_ENABLE_STATE'; END IF;
    UPDATE public.queue_admission_policies SET status='ENABLED',revision=revision+1 WHERE policy_id=pid;
    RETURN public.aun_admission_status(pid);
  END IF;
  ord := (input->>'ordinal')::integer;
  IF ord IS NULL OR ord NOT IN (1,2) THEN RAISE EXCEPTION 'ADMISSION_ORDINAL_INVALID'; END IF;
  IF action='enroll' THEN
    IF p.status NOT IN ('PREPARED','ENABLED') OR EXISTS(SELECT FROM public.queue_admission_tasks WHERE policy_id=pid AND ordinal=ord) THEN RAISE EXCEPTION 'ADMISSION_ENROLL_REPLAY'; END IF;
    IF ord=2 AND NOT EXISTS(SELECT FROM public.queue_admission_tasks WHERE policy_id=pid AND ordinal=1 AND stage='ACCEPTED') THEN RAISE EXCEPTION 'ADMISSION_PREDECESSOR_NOT_ACCEPTED'; END IF;
    SELECT * INTO q FROM public.message_queue WHERE message_id=input->>'message_id' AND agent_id=p.agent_id FOR UPDATE NOWAIT;
    IF NOT FOUND OR q.status<>'pending' OR q.claimed_by IS NOT NULL OR q.created_at<p.installed_at THEN RAISE EXCEPTION 'ADMISSION_GENUINE_PENDING_ROW_REQUIRED'; END IF;
    SELECT * INTO m FROM public.agent_messages WHERE id::text=q.message_id;
    def := p.config->'task_definitions'->(ord-1);
    IF m.id IS NULL OR m.author_id IS DISTINCT FROM def->>'sender' OR m.channel_id IS DISTINCT FROM def->>'channel_id'
       OR input->>'definition_ref' IS DISTINCT FROM def->>'ref'
       OR input->>'content_sha256' IS DISTINCT FROM encode(sha256(convert_to(m.content,'UTF8')),'hex')
       OR input->>'payload_sha256' IS DISTINCT FROM encode(sha256(convert_to(q.payload,'UTF8')),'hex')
       OR NULLIF(input->>'normal_return_ref','') IS NULL OR NULLIF(input->>'authority_url','') IS NULL
       OR COALESCE(input->>'authority_sha256','')!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'ADMISSION_ENROLL_BINDING_MISMATCH'; END IF;
    IF ord=2 AND (m.created_at <= (SELECT accepted_at FROM public.queue_admission_tasks WHERE policy_id=pid AND ordinal=1)
      OR input->>'predecessor_evidence_sha256' IS DISTINCT FROM (SELECT acceptance->>'evidence_sha256' FROM public.queue_admission_tasks WHERE policy_id=pid AND ordinal=1)) THEN RAISE EXCEPTION 'ADMISSION_PRE_SENT_OR_WRONG_PREDECESSOR'; END IF;
    INSERT INTO public.queue_admission_tasks(policy_id,ordinal,queue_id,message_id,binding,stage)
      VALUES(pid,ord,q.id,q.message_id,input||jsonb_build_object('agent_id',p.agent_id,'sender',m.author_id,'channel_id',m.channel_id),'ENROLLED');
  ELSE
    SELECT * INTO t FROM public.queue_admission_tasks WHERE policy_id=pid AND ordinal=ord FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_TASK_NOT_ENROLLED'; END IF;
    SELECT * INTO q FROM public.message_queue WHERE id=t.queue_id FOR UPDATE NOWAIT;
    IF NOT FOUND OR q.agent_id<>p.agent_id OR q.message_id<>t.message_id THEN RAISE EXCEPTION 'ADMISSION_TASK_DRIFT'; END IF;
    IF action='claim' THEN
      IF p.status<>'ENABLED' OR t.stage<>'ENROLLED' OR t.invocation_attempts<>0 OR q.status<>'pending'
        OR EXISTS(SELECT FROM public.queue_admission_tasks WHERE policy_id=pid AND ordinal<>ord AND stage<>'ACCEPTED') THEN RAISE EXCEPTION 'ADMISSION_CLAIM_DENIED'; END IF;
      IF input->>'runtime_id' IS DISTINCT FROM p.config->>'runtime_id' OR input->>'source_sha' IS DISTINCT FROM p.config->>'source_sha'
        OR input->>'cohort_digest' IS DISTINCT FROM p.config->>'cohort_digest' THEN RAISE EXCEPTION 'ADMISSION_RUNTIME_MISMATCH'; END IF;
      IF p.expires_at<=stamp+make_interval(secs=>(p.config->>'worker_timeout_seconds')::integer) THEN RAISE EXCEPTION 'ADMISSION_WORKER_WINDOW_INVALID'; END IF;
      n:=q; n.status:='received'; n.read_at:=stamp; n.claimed_by:=p.agent_id; n.claimed_at:=stamp;
      n.claim_expires_at:=LEAST(p.expires_at,stamp+make_interval(secs=>(p.config->>'worker_timeout_seconds')::integer));
      IF n.claim_expires_at IS NULL OR n.claim_expires_at<=stamp THEN RAISE EXCEPTION 'ADMISSION_WORKER_WINDOW_INVALID'; END IF;
      fence:=jsonb_build_object('claimed_by',n.claimed_by,'claimed_at',n.claimed_at::text,'runtime_id',input->>'runtime_id');
      n.payload:=(q.payload::jsonb || jsonb_build_object('receive_claim',jsonb_build_object('source','bounded-admission',
        'agent_id',p.agent_id,'queue_id',q.id,'policy_id',pid,'runtime_id',input->>'runtime_id')))::text;
      PERFORM public.aun_admission_permit(pid,'message_queue',to_jsonb(q),to_jsonb(n));
      UPDATE public.message_queue SET status=n.status,read_at=n.read_at,claimed_by=n.claimed_by,claimed_at=n.claimed_at,
        claim_expires_at=n.claim_expires_at,payload=n.payload WHERE id=q.id;
      UPDATE public.queue_admission_tasks SET claim_fence=fence WHERE policy_id=pid AND ordinal=ord;
    ELSIF action='invoke' THEN
      IF p.status<>'ENABLED' OR t.stage<>'ENROLLED' OR t.invocation_attempts<>0 OR q.status<>'received'
        OR input->'claim_fence' IS DISTINCT FROM t.claim_fence OR q.claim_expires_at<=stamp
        OR p.expires_at<=stamp+make_interval(secs=>(p.config->>'worker_timeout_seconds')::integer) THEN RAISE EXCEPTION 'ADMISSION_INVOCATION_DENIED'; END IF;
      n:=q; n.status:='in_progress';
      n.payload:=(q.payload::jsonb||jsonb_build_object('queue_work_execution',jsonb_build_object(
        'source','bounded-admission','agent_id',p.agent_id,'queue_id',q.id,'runtime_id',t.claim_fence->>'runtime_id',
        'claimed_by',q.claimed_by,'claimed_at',q.claimed_at::text,'started_at',stamp)))::text;
      PERFORM public.aun_admission_permit(pid,'message_queue',to_jsonb(q),to_jsonb(n));
      UPDATE public.message_queue SET status=n.status,payload=n.payload WHERE id=q.id;
      UPDATE public.queue_admission_tasks SET stage='INVOKING',invocation_attempts=1 WHERE policy_id=pid AND ordinal=ord;
    ELSIF action='result' THEN
      IF t.stage<>'INVOKING' OR t.invocation_attempts<>1 OR input->'claim_fence' IS DISTINCT FROM t.claim_fence THEN RAISE EXCEPTION 'ADMISSION_RESULT_FENCE'; END IF;
      v_result:=input->'result';
      IF jsonb_typeof(v_result)<>'object' OR v_result->>'schema_version' IS DISTINCT FROM 'queue_work_result_v1'
         OR jsonb_typeof(v_result->'ok')<>'boolean' THEN RAISE EXCEPTION 'ADMISSION_RESULT_INVALID'; END IF;
      -- Preserve the exact SQL timestamp text (including microseconds) used by
      -- existing normal host-finalizer checks. JS millisecond rounding is not
      -- an exact claim fence, and client time does not own done_at.
      v_result:=v_result||jsonb_build_object('runtime_id',p.config->>'runtime_id','invocation_source','bounded-admission',
        'claim_fence',t.claim_fence,'completed_at',stamp::text);
      n:=q; n.payload:=(q.payload::jsonb||jsonb_build_object('runner_result',v_result))::text;
      IF v_result->>'ok'='true' AND p.status='ENABLED' AND p.expires_at>stamp THEN n.status:='done'; n.done_at:=stamp; END IF;
      PERFORM public.aun_admission_permit(pid,'message_queue',to_jsonb(q),to_jsonb(n));
      UPDATE public.message_queue SET status=n.status,payload=n.payload,done_at=n.done_at WHERE id=q.id;
      UPDATE public.queue_admission_tasks SET stage=CASE WHEN n.status='done' THEN 'RESULT_SAVED' ELSE 'HALTED' END,
        result_digest=public.aun_admission_digest(v_result) WHERE policy_id=pid AND ordinal=ord;
      IF n.status<>'done' THEN UPDATE public.queue_admission_policies SET status='HALTED',halt_code='OUTCOME_UNKNOWN_OR_FAILED',notice_reserved=true WHERE policy_id=pid; END IF;
    ELSIF action='begin_finalize' THEN
      IF p.status<>'ENABLED' OR t.stage<>'RESULT_SAVED' OR t.finalizer_attempts<>0 OR q.status<>'done'
        OR input->'claim_fence' IS DISTINCT FROM t.claim_fence OR input->>'result_digest' IS DISTINCT FROM t.result_digest THEN RAISE EXCEPTION 'ADMISSION_FINALIZER_DENIED'; END IF;
      UPDATE public.queue_admission_tasks SET stage='FINALIZING',finalizer_attempts=1 WHERE policy_id=pid AND ordinal=ord;
    ELSIF action='reply_lock' THEN
      IF p.status<>'ENABLED' OR t.stage<>'FINALIZING' OR t.finalizer_attempts<>1 OR q.status<>'done'
        OR input->'claim_fence' IS DISTINCT FROM t.claim_fence OR input->>'result_digest' IS DISTINCT FROM t.result_digest THEN RAISE EXCEPTION 'ADMISSION_REPLY_FENCE'; END IF;
      RETURN public.aun_admission_status(pid);
    ELSIF action='writeback_receipt' THEN
      IF p.status<>'ENABLED' OR t.stage<>'FINALIZING' OR t.finalizer_attempts<>1 OR q.status<>'done'
        OR input->'claim_fence' IS DISTINCT FROM t.claim_fence OR input->>'result_digest' IS DISTINCT FROM t.result_digest
        OR NULLIF(input->>'posted_with','') IS NULL OR COALESCE(input->>'body_sha256','')!~'^[0-9a-f]{64}$'
        OR q.payload::jsonb ? 'writeback_result' THEN RAISE EXCEPTION 'ADMISSION_WRITEBACK_RECEIPT_INVALID'; END IF;
      n:=q; n.payload:=(q.payload::jsonb || jsonb_build_object('writeback_result',jsonb_build_object(
        'posted_with',input->>'posted_with','body_sha256',input->>'body_sha256','completed_at',stamp)))::text;
      PERFORM public.aun_admission_permit(pid,'message_queue',to_jsonb(q),to_jsonb(n));
      UPDATE public.message_queue SET payload=n.payload WHERE id=q.id;
    ELSIF action='reply_commit' THEN
      IF p.status<>'ENABLED' OR t.stage<>'FINALIZING' OR t.finalizer_attempts<>1 OR q.status<>'done'
        OR input->'claim_fence' IS DISTINCT FROM t.claim_fence OR input->>'result_digest' IS DISTINCT FROM t.result_digest THEN RAISE EXCEPTION 'ADMISSION_REPLY_FENCE'; END IF;
      SELECT * INTO m FROM public.agent_messages WHERE id::text=input->>'reply_id';
      IF NOT FOUND OR m.reply_to::text IS DISTINCT FROM t.message_id OR m.author_id<>p.agent_id OR m.created_at<t.enrolled_at THEN RAISE EXCEPTION 'ADMISSION_REPLY_BINDING'; END IF;
      n:=q; n.status:='replied'; n.replied_at:=stamp; n.replied_with:=m.id::text;
      PERFORM public.aun_admission_permit(pid,'message_queue',to_jsonb(q),to_jsonb(n));
      UPDATE public.message_queue SET status=n.status,replied_at=n.replied_at,replied_with=n.replied_with WHERE id=q.id;
      UPDATE public.queue_admission_tasks SET stage='REPLIED',reply_id=m.id::text WHERE policy_id=pid AND ordinal=ord;
    ELSIF action='accept' THEN
      IF t.stage<>'REPLIED' OR q.status<>'replied' OR input->>'checker' IS DISTINCT FROM p.config->>'checker'
        OR input->>'checker'=p.config->>'maker' OR input->>'source_sha' IS DISTINCT FROM p.config->>'source_sha'
        OR input->>'result_digest' IS DISTINCT FROM t.result_digest OR input->>'reply_id' IS DISTINCT FROM t.reply_id
        OR input->>'message_id' IS DISTINCT FROM t.message_id OR NULLIF(input->>'authority_url','') IS NULL
        OR COALESCE(input->>'authority_sha256','')!~'^[0-9a-f]{64}$'
        OR COALESCE(input->>'evidence_sha256','')!~'^[0-9a-f]{64}$'
        OR input->>'predicate_status' IS DISTINCT FROM 'VERIFIED_PASS'
        OR input->>'acceptance_kind' IS DISTINCT FROM 'independent_task_acceptance'
        OR NULLIF(input->>'shirube_event_ref','') IS NULL THEN RAISE EXCEPTION 'ADMISSION_ACCEPTANCE_INVALID'; END IF;
      IF NOT EXISTS(SELECT FROM public.outbound_queue o, LATERAL jsonb_array_elements(o.delivery_diagnostics) d
        WHERE o.message_id=t.reply_id AND o.status='sent' AND o.discord_message_id IS NOT NULL
        AND d->>'code'='AUN_BOUNDED_ADMISSION' AND d->>'policy_id'=pid AND d->>'outcome'='SENT'
        AND d->'ack'->>'message_id'=o.discord_message_id)
        THEN RAISE EXCEPTION 'ADMISSION_DELIVERY_NOT_CONFIRMED'; END IF;
      UPDATE public.queue_admission_tasks SET stage='ACCEPTED',acceptance=input,accepted_at=stamp WHERE policy_id=pid AND ordinal=ord;
      IF ord=2 THEN UPDATE public.queue_admission_policies SET status='CLOSED' WHERE policy_id=pid; END IF;
    ELSE RAISE EXCEPTION 'ADMISSION_ACTION_INVALID'; END IF;
  END IF;
  UPDATE public.queue_admission_policies SET revision=revision+1 WHERE policy_id=pid;
  RETURN public.aun_admission_status(pid);
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_seal_send(mid text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.queue_admission_policies;
BEGIN
  FOR p IN SELECT * FROM public.queue_admission_policies ORDER BY policy_id LOOP
    PERFORM public.aun_admission_classify(mid,p.agent_id,p.policy_id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.aun_admission_outbound(oid bigint, action text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.queue_admission_policies; t public.queue_admission_tasks; o public.outbound_queue; n public.outbound_queue;
  m public.agent_messages; next_m public.agent_messages; diag jsonb; next_diag jsonb;
  stamp timestamptz:=clock_timestamp(); due timestamptz; horizon timestamptz; request jsonb; ack jsonb;
  max_posts integer; notice_id bigint; notice_payload text; destinations jsonb; wait_ms numeric; persistence jsonb;
BEGIN
  -- Lookup is non-locking; all authoritative checks repeat under policy/task/row order.
  SELECT d INTO diag FROM public.outbound_queue source_projection, LATERAL jsonb_array_elements(source_projection.delivery_diagnostics) d
    WHERE source_projection.id=oid AND d->>'code'='AUN_BOUNDED_ADMISSION';
  IF diag IS NULL THEN RAISE EXCEPTION 'ADMISSION_OUTBOUND_NOT_BOUND'; END IF;
  p:=public.aun_admission_lock(diag->>'policy_id',action IN ('freeze','claim','provider_check'));
  IF action='recover_receipt' OR input ? 'recovery_token' THEN
    IF action NOT IN ('recover_receipt','sent','backfill','halt') THEN RAISE EXCEPTION 'ADMISSION_RECOVERY_ACTION_DENIED'; END IF;
    PERFORM public.aun_admission_assert_principal(p.config,'controller');
  ELSE PERFORM public.aun_admission_assert_principal(p.config,'runtime'); END IF;
  SELECT * INTO t FROM public.queue_admission_tasks WHERE policy_id=p.policy_id AND queue_id=(diag->>'original_queue_id')::bigint FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_HOLD_ENROLL'; END IF;
  SELECT * INTO o FROM public.outbound_queue WHERE id=oid FOR UPDATE NOWAIT;
  max_posts:=CASE diag->>'kind' WHEN 'reply' THEN 3 ELSE 1 END;
  IF NOT FOUND OR NOT o.delivery_diagnostics @> jsonb_build_array(diag) OR diag->>'config_digest'<>p.config_digest
    OR o.max_attempts<>max_posts THEN RAISE EXCEPTION 'ADMISSION_PROJECTION_DRIFT'; END IF;
  n:=o; next_diag:=diag;
  IF action='recover_receipt' THEN
    IF input->>'expected_digest' IS DISTINCT FROM p.config_digest OR input->>'expected_revision' IS DISTINCT FROM p.revision::text
      OR input->>'source_sha' IS DISTINCT FROM p.config->>'source_sha' OR COALESCE(input->>'recovery_token','')!~'^[A-Za-z0-9_-]{1,120}$'
      OR COALESCE(input->>'receipt_sha256','')!~'^[0-9a-f]{64}$' OR input->>'request_digest' IS DISTINCT FROM diag->>'request_digest'
      OR COALESCE(input->>'authority_sha256','')!~'^[0-9a-f]{64}$' OR NULLIF(input->>'authority_url','') IS NULL
      OR jsonb_typeof(input->'authority_expires_at') IS DISTINCT FROM 'string'
      OR (input->>'authority_expires_at')::timestamptz<=stamp OR o.attempts<1
      OR jsonb_typeof(input->'persistence_started_at') IS DISTINCT FROM 'string'
      OR (input->>'persistence_started_at')::timestamptz>stamp
      OR (input->>'persistence_started_at')::timestamptz<=stamp-interval '20 seconds'
      OR COALESCE(diag->'recovery_tokens','[]'::jsonb) ? (input->>'recovery_token') THEN RAISE EXCEPTION 'ADMISSION_RECOVERY_INVALID'; END IF;
    next_diag:=diag||jsonb_build_object('recovery_token',input->>'recovery_token','recovery_started_at',stamp::text,
      'recovery_tokens',COALESCE(diag->'recovery_tokens','[]'::jsonb)||jsonb_build_array(input->>'recovery_token'),
      'recovery_authority',jsonb_build_object('url',input->>'authority_url','sha256',input->>'authority_sha256'),
      'persistence',jsonb_build_object('started_at',input->>'persistence_started_at','writes',0));
  END IF;
  IF action IN ('sent','backfill') THEN
    persistence:=input->'persistence';
    IF jsonb_typeof(persistence) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(persistence) k) IS DISTINCT FROM ARRAY['started_at','writes']
      OR jsonb_typeof(persistence->'started_at') IS DISTINCT FROM 'string'
      OR jsonb_typeof(persistence->'writes') IS DISTINCT FROM 'number'
      OR (persistence->>'writes')!~'^[1-5]$'
      OR COALESCE((persistence->>'writes')::integer,0) NOT BETWEEN 1 AND 5
      OR (persistence->>'started_at')::timestamptz>stamp
      OR stamp>=(persistence->>'started_at')::timestamptz+interval '20 seconds'
      OR (diag ? 'persistence' AND (persistence->>'writes')::integer<(diag->'persistence'->>'writes')::integer)
      OR (diag ? 'persistence' AND (persistence->>'started_at')::timestamptz IS DISTINCT FROM (diag->'persistence'->>'started_at')::timestamptz)
      OR (input ? 'recovery_token' AND (input->>'recovery_token' IS DISTINCT FROM diag->>'recovery_token'
        OR stamp>=(diag->>'recovery_started_at')::timestamptz+interval '20 seconds')) THEN RAISE EXCEPTION 'ADMISSION_PERSISTENCE_BUDGET_DENIED'; END IF;
    next_diag:=diag||jsonb_build_object('persistence',persistence);
  END IF;
  IF action IN ('freeze','claim','provider_check') THEN
    IF input->>'consumer_agent_id' IS DISTINCT FROM COALESCE(o.consumer_agent_id,o.agent_id)
      OR input->>'cohort_digest' IS DISTINCT FROM p.config->>'cohort_digest'
      OR input->>'source_sha' IS DISTINCT FROM p.config->>'source_sha'
      OR (diag->>'kind'='reply' AND (t.stage NOT IN ('REPLIED','ACCEPTED') OR t.reply_id<>o.message_id)) THEN
      RAISE EXCEPTION 'ADMISSION_PROJECTION_DENIED';
    END IF;
  END IF;
  IF action='recover_receipt' THEN NULL;
  ELSIF action='freeze' THEN
    IF o.status<>'pending' OR o.attempts<>0 OR NULLIF(input->>'request_bytes','') IS NULL THEN RAISE EXCEPTION 'ADMISSION_REQUEST_INVALID'; END IF;
    request:=(input->>'request_bytes')::jsonb;
    IF request->>'delivery_id' IS DISTINCT FROM 'out-'||o.id::text OR request->>'channel_id' IS DISTINCT FROM o.channel_external_id
      OR request->'body'->>'nonce' IS DISTINCT FROM 'out-'||o.id::text OR request->'body'->'enforce_nonce' IS DISTINCT FROM 'true'::jsonb
      OR COALESCE(request->>'author_id','')!~'^[1-9][0-9]{0,19}$'
      OR input->>'request_digest' IS DISTINCT FROM encode(sha256(convert_to(input->>'request_bytes','UTF8')),'hex') THEN RAISE EXCEPTION 'ADMISSION_REQUEST_INVALID'; END IF;
    IF diag ? 'request_digest' THEN
      IF diag->>'request_digest' IS DISTINCT FROM input->>'request_digest' OR diag->>'request_bytes' IS DISTINCT FROM input->>'request_bytes' THEN RAISE EXCEPTION 'ADMISSION_REQUEST_CHANGED'; END IF;
      RETURN to_jsonb(o);
    END IF;
    next_diag:=diag||jsonb_build_object('request_digest',input->>'request_digest','request_bytes',input->>'request_bytes',
      'delivery_id','out-'||o.id::text,'outcome','READY','wire_calls',0);
  ELSIF action='claim' THEN
    IF o.status<>'pending' OR o.attempts>=max_posts OR diag->>'outcome' NOT IN ('READY','RETRYABLE')
      OR NOT diag ? 'request_digest' OR NULLIF(input->>'owner_token','') IS NULL
      OR input->>'owner_host' IS DISTINCT FROM p.config->'transport'->>'host'
      OR NULLIF(input->>'owner_start','') IS NULL OR COALESCE((input->>'owner_pid')::integer,0)<=0
      OR (o.attempts>0 AND (diag->>'kind'<>'reply' OR diag->>'outcome'<>'RETRYABLE'))
      OR diag ? 'ack' THEN RAISE EXCEPTION 'ADMISSION_PROJECTION_DENIED'; END IF;
    request:=(diag->>'request_bytes')::jsonb;
    horizon:=LEAST(p.expires_at,COALESCE((diag->>'first_attempt_at')::timestamptz,stamp)+interval '120 seconds');
    due:=GREATEST(COALESCE(o.next_retry_at,stamp),COALESCE((SELECT max((bp.bot_not_before->>(request->>'author_id'))::timestamptz)
      FROM public.queue_admission_policies bp),stamp));
    IF stamp<due THEN RAISE EXCEPTION 'ADMISSION_DELIVERY_NOT_DUE'; END IF;
    IF stamp+interval '10 seconds'>horizon THEN RAISE EXCEPTION 'ADMISSION_DELIVERY_WINDOW_EXPIRED'; END IF;
    n.status:='claimed'; n.attempts:=o.attempts+1; n.claimed_at:=stamp;
    next_diag:=diag||jsonb_build_object('outcome','INTENT','owner_token',input->>'owner_token',
      'owner_host',input->>'owner_host','owner_start',input->>'owner_start','owner_pid',(input->>'owner_pid')::integer,
      'first_attempt_at',COALESCE(diag->>'first_attempt_at',stamp::text),'reserved_at',stamp::text);
  ELSIF action='provider_check' THEN
    IF o.status<>'claimed' OR o.attempts<1 OR o.attempts>max_posts OR diag->>'outcome'<>'INTENT'
      OR input->>'owner_token' IS DISTINCT FROM diag->>'owner_token'
      OR input->>'request_digest' IS DISTINCT FROM diag->>'request_digest'
      OR input->>'claimed_at' IS DISTINCT FROM to_jsonb(o)->>'claimed_at' OR diag ? 'ack' THEN RAISE EXCEPTION 'ADMISSION_PROJECTION_FENCE'; END IF;
    request:=(diag->>'request_bytes')::jsonb;
    IF stamp+interval '10 seconds'>LEAST(p.expires_at,(diag->>'first_attempt_at')::timestamptz+interval '120 seconds')
      OR stamp<COALESCE((SELECT max((bp.bot_not_before->>(request->>'author_id'))::timestamptz)
        FROM public.queue_admission_policies bp),stamp) THEN RAISE EXCEPTION 'ADMISSION_DELIVERY_WINDOW_EXPIRED'; END IF;
    RETURN to_jsonb(o);
  ELSIF action IN ('retry','ack') THEN
    IF o.status<>'claimed' OR diag->>'outcome'<>'INTENT'
      OR input->>'owner_token' IS DISTINCT FROM diag->>'owner_token'
      OR input->>'request_digest' IS DISTINCT FROM diag->>'request_digest'
      OR input->>'claimed_at' IS DISTINCT FROM to_jsonb(o)->>'claimed_at'
      OR COALESCE((input->>'wire_calls')::integer,-1) NOT BETWEEN 0 AND 1 THEN RAISE EXCEPTION 'ADMISSION_PROJECTION_FENCE'; END IF;
    next_diag:=diag||jsonb_build_object('wire_calls',COALESCE((diag->>'wire_calls')::integer,0)+(input->>'wire_calls')::integer);
    IF action='retry' THEN
      IF diag->>'kind'<>'reply' OR o.attempts>=3 OR p.status<>'ENABLED' OR diag ? 'ack'
        OR COALESCE((input->>'retry_after_ms')::numeric,-1)<0 THEN RAISE EXCEPTION 'ADMISSION_REDELIVERY_DENIED'; END IF;
      wait_ms:=GREATEST(CASE o.attempts WHEN 1 THEN 10000 ELSE 30000 END,(input->>'retry_after_ms')::numeric);
      due:=stamp+make_interval(secs=>ceil(wait_ms)/1000);
      IF due+interval '10 seconds'>LEAST(p.expires_at,(diag->>'first_attempt_at')::timestamptz+interval '120 seconds') THEN RAISE EXCEPTION 'ADMISSION_DELIVERY_WINDOW_EXPIRED'; END IF;
      IF input->>'global'='true' THEN
        request:=(diag->>'request_bytes')::jsonb;
        UPDATE public.queue_admission_policies SET bot_not_before=bot_not_before||jsonb_build_object(request->>'author_id',due::text) WHERE policy_id=p.policy_id;
      END IF;
      n.status:='pending';n.next_retry_at:=due;
      next_diag:=next_diag||jsonb_build_object('outcome','RETRYABLE','failed_at',stamp::text,'next_not_before',due::text,'reason',input->>'reason');
    ELSE
      ack:=input->'ack';request:=(diag->>'request_bytes')::jsonb;
      IF COALESCE(ack->>'message_id','')!~'^[1-9][0-9]{0,19}$'
        OR ack->>'channel_id' IS DISTINCT FROM request->>'channel_id' OR ack->>'author_id' IS DISTINCT FROM request->>'author_id'
        OR ack->>'nonce' IS DISTINCT FROM diag->>'delivery_id' OR COALESCE(ack->>'response_sha256','')!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'ADMISSION_PROVIDER_RECEIPT_CONFLICT'; END IF;
      next_diag:=next_diag||jsonb_build_object('outcome','ACK_PENDING_DB','ack',ack);
    END IF;
  ELSIF action='sent' THEN
    ack:=input->'ack';request:=(diag->>'request_bytes')::jsonb;
    IF o.status NOT IN ('claimed','sent') OR o.attempts<1 OR o.attempts>max_posts
      OR input->>'owner_token' IS DISTINCT FROM diag->>'owner_token'
      OR input->>'request_digest' IS DISTINCT FROM diag->>'request_digest'
      OR COALESCE(ack->>'message_id','')!~'^[1-9][0-9]{0,19}$' OR ack->>'channel_id' IS DISTINCT FROM request->>'channel_id'
      OR ack->>'author_id' IS DISTINCT FROM request->>'author_id' OR ack->>'nonce' IS DISTINCT FROM diag->>'delivery_id'
      OR COALESCE(ack->>'response_sha256','')!~'^[0-9a-f]{64}$'
      OR (diag ? 'ack' AND diag->'ack'<>ack)
      OR (o.discord_message_id IS NOT NULL AND o.discord_message_id<>ack->>'message_id') THEN RAISE EXCEPTION 'ADMISSION_PROJECTION_FENCE'; END IF;
    n.status:='sent';n.sent_at:=COALESCE(o.sent_at,stamp);n.discord_message_id:=ack->>'message_id';
    IF COALESCE((input->>'total_wire_calls')::integer,-1) NOT BETWEEN 0 AND o.attempts THEN RAISE EXCEPTION 'ADMISSION_WIRE_COUNT_INVALID'; END IF;
    next_diag:=next_diag||jsonb_build_object('outcome','SENT','ack',ack,'wire_calls',(input->>'total_wire_calls')::integer);
  ELSIF action='backfill' THEN
    -- Separate, receipt-only second stage. Failure cannot roll back mark-sent
    -- or authorize another provider call. No new claim/attempt is reserved.
    IF o.status<>'sent' OR o.attempts<1 OR o.attempts>max_posts OR o.discord_message_id IS NULL
      OR input->>'provider_message_id' IS DISTINCT FROM o.discord_message_id THEN RAISE EXCEPTION 'ADMISSION_PROJECTION_FENCE'; END IF;
    SELECT * INTO m FROM public.agent_messages WHERE id::text=o.message_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_MESSAGE_NOT_FOUND'; END IF;
    IF m.discord_message_id IS NOT NULL THEN
      IF m.discord_message_id<>o.discord_message_id THEN RAISE EXCEPTION 'ADMISSION_PROVIDER_RECEIPT_CONFLICT'; END IF;
    ELSE
      next_m:=m; next_m.discord_message_id:=o.discord_message_id;
      PERFORM public.aun_admission_permit(p.policy_id,'agent_messages',to_jsonb(m),to_jsonb(next_m));
      UPDATE public.agent_messages SET discord_message_id=next_m.discord_message_id WHERE id=m.id;
    END IF;
    next_diag:=next_diag||jsonb_build_object('backfill_complete',true);
  ELSIF action='halt' THEN
    n.last_error:=COALESCE(input->>'reason','OUTCOME_UNKNOWN');
    next_diag:=diag||jsonb_build_object('outcome','NEEDS_ATTENTION','reason',n.last_error);
    IF diag->>'outcome'='SENT' THEN next_diag:=diag; END IF;
    -- Preserve claim/counters even when no provider effect can be established.
    UPDATE public.queue_admission_policies SET status=CASE WHEN status='CLOSED' THEN status ELSE 'HALTED' END,
      halt_code=COALESCE(halt_code,n.last_error),notice_reserved=true,revision=revision+1 WHERE policy_id=p.policy_id;
    destinations:=p.notice_deliveries;
    IF NOT destinations @> jsonb_build_array('out-'||o.id::text) THEN destinations:=destinations||jsonb_build_array('out-'||o.id::text); END IF;
    notice_payload:=jsonb_build_object('author_id','system','message_type','system_error','channel_name','system',
      'target_agent_id','codex-cto','source_message_id',NULL,'policy_id',p.policy_id,'deliveries',destinations,
      'content','Bounded delivery requires controller attention; no task or automatic provider retry is authorized.',
      'reason',n.last_error,'ts',stamp::text)::text;
    notice_id:=p.notice_queue_id;
    IF notice_id IS NULL THEN
      INSERT INTO public.message_queue(agent_id,message_id,payload) VALUES('codex-cto',NULL,notice_payload) RETURNING id INTO notice_id;
    ELSE
      UPDATE public.message_queue SET payload=notice_payload WHERE id=notice_id AND agent_id='codex-cto' AND message_id IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_NOTICE_CONFLICT'; END IF;
    END IF;
    UPDATE public.queue_admission_policies SET notice_queue_id=notice_id,notice_deliveries=destinations WHERE policy_id=p.policy_id;
  ELSE RAISE EXCEPTION 'ADMISSION_ACTION_INVALID'; END IF;
  n.delivery_diagnostics:=(SELECT jsonb_agg(CASE WHEN d->>'code'='AUN_BOUNDED_ADMISSION' THEN next_diag ELSE d END ORDER BY ord)
    FROM jsonb_array_elements(o.delivery_diagnostics) WITH ORDINALITY AS entries(d,ord));
  PERFORM public.aun_admission_permit(p.policy_id,'outbound_queue',to_jsonb(o),to_jsonb(n));
  UPDATE public.outbound_queue SET status=n.status,attempts=n.attempts,claimed_at=n.claimed_at,sent_at=n.sent_at,
    discord_message_id=n.discord_message_id,last_error=n.last_error,next_retry_at=n.next_retry_at,delivery_diagnostics=n.delivery_diagnostics WHERE id=o.id;
  RETURN to_jsonb(n);
END $$;

-- Read-only membership/exclusion predicate, not an execution grant. Matching
-- trigger arguments survive policy visibility/deletion and remain sticky.
CREATE OR REPLACE FUNCTION public.aun_admission_is_protected(agent text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid='public.message_queue'::regclass AND NOT t.tgisinternal
    AND t.tgfoid='public.aun_admission_queue_guard()'::regprocedure AND split_part(encode(t.tgargs,'escape'),'\000',1)=agent)
$$;

-- Apply ownership and default-deny ACL to EVERY core helper, including trigger
-- and permit helpers. Only the explicit public entrypoints below are callable.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'aun_admission_%' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO aun_admission_owner',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, aun_admission_runtime, aun_admission_executor, aun_admission_control',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.aun_admission_prepare(jsonb) TO aun_admission_control;
GRANT EXECUTE ON FUNCTION public.aun_admission_prepare_lock() TO aun_admission_control;
GRANT EXECUTE ON FUNCTION public.aun_admission_status(text) TO aun_admission_control,aun_admission_runtime,aun_admission_executor;
GRANT EXECUTE ON FUNCTION public.aun_admission_agent_status(text) TO aun_admission_control,aun_admission_runtime,aun_admission_executor;
GRANT EXECUTE ON FUNCTION public.aun_admission_transition(text,bigint,text,text,jsonb) TO aun_admission_control,aun_admission_executor;
GRANT EXECUTE ON FUNCTION public.aun_admission_outbound(bigint,text,jsonb) TO aun_admission_runtime,aun_admission_control;
GRANT EXECUTE ON FUNCTION public.aun_admission_seal_send(text) TO aun_admission_runtime,aun_admission_executor,aun_admission_control;
GRANT EXECUTE ON FUNCTION public.aun_admission_is_protected(text) TO aun_admission_control,aun_admission_runtime,aun_admission_executor;
GRANT EXECUTE ON FUNCTION public.aun_admission_digest(jsonb) TO aun_admission_control;
GRANT EXECUTE ON FUNCTION public.aun_admission_capability() TO aun_admission_control,aun_admission_runtime,aun_admission_executor;
COMMIT;
