-- D4: restoring a physical-writing version is not a compatible rollback.
DO $$ BEGIN RAISE EXCEPTION 'AUN_NONPERSISTENCE_ROLLBACK_INCOMPATIBLE'; END $$;
