-- ============================================================================
-- Classyx: enforce column-level privileges on public.children
-- ----------------------------------------------------------------------------
-- A table-level SELECT/INSERT/UPDATE grant in Postgres implicitly covers EVERY
-- column, so the earlier `REVOKE SELECT (pin_hash)` was a no-op while the
-- table-level grant existed (verified: the hash was still readable/writable).
--
-- Fix: drop the broad grants for anon/authenticated and re-grant only the safe
-- columns. pin_hash is deliberately excluded, so it can never be read or written
-- through the API — the ONLY way to set it is set_child_pin() (SECURITY DEFINER,
-- runs as owner). service_role keeps full access (used by the Edge Function).
--
-- NOTE for the client: never `select('*')` on children — select explicit
-- columns (id, family_id, name, grade, created_at), or PostgREST will request
-- pin_hash and get "permission denied".
-- ============================================================================

-- anon should have no direct access to children at all (RLS already denies it;
-- this is defense in depth).
revoke all on public.children from anon;

-- Replace authenticated's table-wide grants with column-scoped ones.
revoke select, insert, update on public.children from authenticated;

grant select (id, family_id, name, grade, created_at) on public.children to authenticated;
grant insert (family_id, name, grade)                 on public.children to authenticated;
grant update (name, grade)                            on public.children to authenticated;
-- DELETE stays table-level (gated by RLS) so parents can remove a child profile.
grant delete on public.children to authenticated;
