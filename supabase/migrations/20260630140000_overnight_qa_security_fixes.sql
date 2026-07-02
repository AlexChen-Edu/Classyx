-- ============================================================================
-- Overnight QA pass: security/performance advisor fixes.
-- ----------------------------------------------------------------------------
-- 1. families RLS policy re-evaluated auth.uid() per row (Postgres can't cache
--    a bare function call across rows the way it can a scalar subquery).
--    Wrapping it as (select auth.uid()) lets the planner evaluate it once per
--    statement instead of once per row. No behavior change — same predicate.
-- ============================================================================

drop policy if exists "families: owner all" on public.families;
create policy "families: owner all" on public.families
  for all to authenticated
  using (parent_id = (select auth.uid()))
  with check (parent_id = (select auth.uid()));
