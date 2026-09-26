-- Removed host observations cannot be reconstructed, and old physical writers
-- are incompatible. Roll back the application only to a verified compatible release.
DO $$ BEGIN RAISE EXCEPTION 'AUN_NONPERSISTENCE_COMPATIBLE_ROLLBACK_REQUIRED'; END $$;
