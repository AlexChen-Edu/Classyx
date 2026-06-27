-- ============================================================================
-- Fix: "Active now" presence indicator never showed on the parent dashboard.
-- ----------------------------------------------------------------------------
-- Root cause: owns_child() was SECURITY INVOKER (set in
-- 20260623121000_classyx_security_hardening.sql). The "active_sessions:
-- parent select" policy (20260626130000_active_sessions.sql) calls
-- owns_child(child_id), which — as INVOKER — queries public.children. But
-- children has its own RLS policy ("children: owner all") that calls
-- owns_family(family_id), which in turn queries public.families (also
-- RLS-protected). Nesting RLS-protected table reads inside an INVOKER
-- function called from another table's policy triggers Postgres's
-- "infinite recursion detected in policy for relation \"children\"" error —
-- even though there's no logical cycle, Postgres's policy planner can't
-- prove that statically.
--
-- getActiveSessions() (api.js) surfaced this as a thrown error, which
-- dashboard.js's fetchPresence() silently swallows (by design — presence is
-- a nice-to-have that shouldn't block the rest of the dashboard), so the
-- failure was invisible: the dot just never appeared, with nothing in the
-- console to explain why.
--
-- Fix: SECURITY DEFINER functions don't re-trigger the recursive policy
-- check, since they evaluate with the function owner's privileges rather
-- than re-entering RLS through the calling role. owns_child only ever
-- compares against auth.uid(), so running it as DEFINER doesn't widen what
-- it returns — it just breaks the recursive-policy-evaluation chain.
--
-- This was applied directly to the live database (hence "fix_" + a later
-- timestamp than every other migration) but never captured as a migration
-- file — recreating the database from migrations alone would have
-- regressed back to the broken INVOKER version. This file makes that fix
-- permanent and reproducible.
-- ============================================================================

create or replace function public.owns_child(child uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.children c
    join public.families f on f.id = c.family_id
    where c.id = child and f.parent_id = auth.uid()
  );
$$;

revoke all on function public.owns_child(uuid) from public, anon;
grant execute on function public.owns_child(uuid) to authenticated;
