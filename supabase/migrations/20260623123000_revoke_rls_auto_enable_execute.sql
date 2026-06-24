-- ============================================================================
-- Harden a PRE-EXISTING function flagged by the security advisor.
-- ----------------------------------------------------------------------------
-- public.rls_auto_enable() is a SECURITY DEFINER function that was executable by
-- the anon and authenticated roles via PostgREST (/rest/v1/rpc/rls_auto_enable).
-- It is only meant to run from its event trigger (which executes as the function
-- owner, NOT through a client role), so no API role needs EXECUTE. Revoking it
-- removes the external attack surface without affecting the event trigger.
--
-- This function was not created by the Classyx app migrations, so the revoke is
-- guarded by an existence check to stay safe on a fresh database.
-- ============================================================================

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
  end if;
end $$;
