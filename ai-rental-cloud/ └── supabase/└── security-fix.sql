-- AI Rental Cloud
-- Supabase security fix

-- Prevent public/anonymous users from executing
-- the auth trigger helper directly.

REVOKE EXECUTE
ON FUNCTION public.handle_new_user()
FROM anon, authenticated;

-- Keep execution available to the PostgreSQL
-- internal role used by the trigger.

GRANT EXECUTE
ON FUNCTION public.handle_new_user()
TO postgres;
