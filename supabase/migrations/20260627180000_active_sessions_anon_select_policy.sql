-- ============================================================================
-- Fix: pingPresence/startPresence's WHERE-filtered UPDATE silently matched
-- zero rows for anon (the account-less child path), which broke pause
-- detection and timer sync on the parent dashboard for any child studying
-- without a parent account.
-- ----------------------------------------------------------------------------
-- Root cause: RLS treats "is this row visible to evaluate a WHERE/USING
-- predicate against" as a SELECT-policy question, separate from the table-
-- level SELECT *grant* added in 20260626131000. That migration's grant
-- satisfies the static privilege check (prevents "permission denied for
-- table"), but with RLS enabled and NO SELECT *policy* for anon, anon's
-- row-visibility is the empty set — so any UPDATE whose WHERE clause
-- references a column (e.g. `where child_id = ...`, exactly what
-- pingPresence/startPresence send) matches 0 rows, even though the
-- "anon update" policy itself is `using (true)`. Verified live: an UPDATE
-- with no WHERE clause (or `where true`) succeeds; the same UPDATE filtered
-- on any real column affects zero rows.
--
-- Fix: add an actual SELECT *policy* for anon (not just a grant), using(true)
-- — matching the same unscoped trust model already applied to the anon
-- insert/update policies (see 20260626130000's comment: an account-less
-- student has no identity to scope a policy to). This does widen anon's
-- access from "can't read anything" to "can list active_sessions rows
-- (child_id + timestamps, no PII)" — the same minor exposure already
-- accepted for the rotating-code system, and necessary for the
-- WHERE-filtered writes this table's entire write path depends on to work
-- at all.
-- ============================================================================

drop policy if exists "active_sessions: anon select" on public.active_sessions;
create policy "active_sessions: anon select" on public.active_sessions
  for select to anon
  using (true);
