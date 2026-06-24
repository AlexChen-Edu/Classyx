-- ============================================================================
-- Classyx security hardening (follow-up to 20260623120000_classyx_app_core)
-- ----------------------------------------------------------------------------
-- 1. Make the ownership helpers SECURITY INVOKER. They are only ever used as
--    RLS policy predicates and only compare against auth.uid(). As INVOKER they
--    no longer trip the "SECURITY DEFINER function exposed via REST" advisor.
--    No recursion results: owns_child/owns_family are never referenced by a
--    policy on a table they themselves read in a cycle.
-- 2. Grant EXECUTE to `authenticated`. RLS evaluation checks EXECUTE on the
--    calling role, so the policies that call these helpers need it. (The
--    original migration revoked the PUBLIC grant without re-granting — fixed.)
-- 3. Revoke INSERT/UPDATE on children.pin_hash so the bcrypt path inside
--    set_child_pin() is the ONLY way to write a PIN (SELECT was already revoked).
-- ============================================================================

create or replace function public.owns_family(fam uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.families f
    where f.id = fam and f.parent_id = auth.uid()
  );
$$;

create or replace function public.owns_child(child uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.children c
    join public.families f on f.id = c.family_id
    where c.id = child and f.parent_id = auth.uid()
  );
$$;

revoke all on function public.owns_family(uuid) from public, anon;
revoke all on function public.owns_child(uuid)  from public, anon;
grant execute on function public.owns_family(uuid) to authenticated;
grant execute on function public.owns_child(uuid)  to authenticated;

-- pin_hash: clients may never read OR write it directly; only set_child_pin()
-- (SECURITY DEFINER, ownership-checked, enforces the 4-digit + bcrypt rule) may.
revoke insert (pin_hash), update (pin_hash) on public.children from anon, authenticated;
