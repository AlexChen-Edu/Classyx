-- ============================================================================
-- Fix: anon storage upload policy used c.name (child display name) instead of
-- objects.name (the storage object path) inside the subquery, so
-- storage.foldername always received a plain string like "Alice" instead of
-- the path "family_id/child_id/uuid.png". The result was an empty array,
-- making the policy always-false and every anon upload fail with a 400.
--
-- Fix: qualify the column as objects.name so PostgreSQL resolves it against
-- storage.objects (the policy target table) rather than the children alias c.
-- ============================================================================

drop policy if exists "uploads bucket: anon write" on storage.objects;
create policy "uploads bucket: anon write" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'uploads'
    and exists (
      select 1 from public.children c
      where c.id::text        = (storage.foldername(objects.name))[2]
        and c.family_id::text = (storage.foldername(objects.name))[1]
        and public.has_live_session(c.id)
    )
  );
