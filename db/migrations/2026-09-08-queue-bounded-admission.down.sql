-- This is removal, NOT the code-rollback route. Code rollback retains deny.
BEGIN;
LOCK TABLE public.agent_messages, public.message_queue, public.outbound_queue IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS(SELECT FROM public.queue_admission_tasks)
    OR EXISTS(SELECT FROM public.queue_admission_policies)
    OR EXISTS(SELECT FROM public.outbound_queue WHERE delivery_diagnostics @> '[{"code":"AUN_BOUNDED_ADMISSION"}]'::jsonb) THEN
    RAISE EXCEPTION 'ADMISSION_DOWN_REFUSED_PROTECTED_HISTORY';
  END IF;
END $$;
-- No CASCADE: unknown dependencies fail rather than remove another surface.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'aun_admission_%' LOOP
    EXECUTE format('DROP FUNCTION %s',f.signature);
  END LOOP;
END $$;
DROP INDEX IF EXISTS public.aun_admission_unique_projection;
DROP TABLE public.queue_admission_tasks;
DROP TABLE public.queue_admission_policies;
-- Leave the independently installed observation topology and history intact.
DO $$ BEGIN
  IF to_regclass('public.fleet_runtime_queue_observation_active') IS NOT NULL THEN
    REVOKE SELECT ON public.fleet_runtime_queue_observation_active FROM aun_admission_owner;
  END IF;
  IF to_regclass('public.fleet_runtime_queue_agent_revisions') IS NOT NULL THEN
    REVOKE SELECT,INSERT,UPDATE ON public.fleet_runtime_queue_agent_revisions FROM aun_admission_owner;
  END IF;
END $$;
-- Roles may be shared by isolated DBs or future deployments; never drop them.
COMMIT;
