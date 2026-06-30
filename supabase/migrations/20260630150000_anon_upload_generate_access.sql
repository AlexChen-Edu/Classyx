-- ============================================================================
-- Account-less (anon) children: scoped access to uploads/flashcards/
-- study_guides/quiz_results + the storage bucket.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS: account-less children (redeem_child_code) have no
-- Supabase Auth session at all, so the normal owns_child()/owns_family()
-- policies (which require auth.uid()) always deny them — they couldn't
-- upload notes, generate flashcards, or even read the results back. anon
-- has no identity to scope a normal RLS policy to, so these policies
-- re-derive authorization the same way active_sessions and
-- save_child_session already do: a live active_sessions row for the
-- child_id, created by startPresence() right after a code is redeemed and
-- deleted on tab close, proves "this caller is the same browser that just
-- redeemed that child's code" without anon needing any identity of its own.
-- ============================================================================

create or replace function public.has_live_session(child uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.active_sessions where child_id = child);
$$;

revoke all on function public.has_live_session(uuid) from public;
grant execute on function public.has_live_session(uuid) to anon, authenticated;

-- uploads: anon may create a row and read it back (the SELECT policy is
-- needed because PostgREST's INSERT...RETURNING applies SELECT RLS to the
-- returned rows, and without a SELECT policy the RETURNING fails even though
-- the INSERT itself would succeed). The Edge Function re-derives ownership
-- independently via the same active_sessions proof rather than relying on
-- this SELECT policy, so this doesn't widen what the server trusts.
drop policy if exists "uploads: anon insert" on public.uploads;
create policy "uploads: anon insert" on public.uploads
  for insert to anon
  with check (public.has_live_session(child_id));

drop policy if exists "uploads: anon select" on public.uploads;
create policy "uploads: anon select" on public.uploads
  for select to anon
  using (public.has_live_session(child_id));

-- flashcards / study_guides: anon may read what was generated for them.
drop policy if exists "flashcards: anon select" on public.flashcards;
create policy "flashcards: anon select" on public.flashcards
  for select to anon
  using (public.has_live_session(child_id));

drop policy if exists "study_guides: anon select" on public.study_guides;
create policy "study_guides: anon select" on public.study_guides
  for select to anon
  using (public.has_live_session(child_id));

-- quiz_results: anon self-test results.
drop policy if exists "quiz_results: anon insert" on public.quiz_results;
create policy "quiz_results: anon insert" on public.quiz_results
  for insert to anon
  with check (public.has_live_session(child_id));

-- storage: anon may write notes into the family/child folder of the child
-- they're currently studying as (path = "<family_id>/<child_id>/...").
-- Both segments are re-derived from the children table server-side, not
-- trusted from the client-supplied path, so a caller can't write into a
-- folder for a family/child pair that doesn't actually match.
drop policy if exists "uploads bucket: anon write" on storage.objects;
create policy "uploads bucket: anon write" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'uploads'
    and exists (
      select 1 from public.children c
      where c.id::text = (storage.foldername(name))[2]
        and c.family_id::text = (storage.foldername(name))[1]
        and public.has_live_session(c.id)
    )
  );
