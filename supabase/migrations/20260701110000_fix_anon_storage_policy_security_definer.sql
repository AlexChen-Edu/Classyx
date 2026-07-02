-- The old storage policy did `FROM children c WHERE ...` inline, but anon has
-- no RLS policy on children (only authenticated does), so EXISTS always returned
-- false and every anon upload got a 400.  Fix: wrap the check in a SECURITY
-- DEFINER function so it runs as the function owner and bypasses RLS on children.

CREATE OR REPLACE FUNCTION public.is_valid_anon_upload_path(object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public', 'storage'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.children c
    WHERE c.family_id::text = (storage.foldername(object_name))[1]
      AND c.id::text       = (storage.foldername(object_name))[2]
      AND public.has_live_session(c.id)
  );
$$;

-- Recreate the storage policy using the new helper
DROP POLICY IF EXISTS "uploads bucket: anon write" ON storage.objects;

CREATE POLICY "uploads bucket: anon write"
  ON storage.objects
  FOR INSERT
  TO anon
  WITH CHECK (
    bucket_id = 'uploads'
    AND public.is_valid_anon_upload_path(name)
  );
