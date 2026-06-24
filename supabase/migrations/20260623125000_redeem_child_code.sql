-- ============================================================================
-- redeem_child_code(code) — anon-callable code redemption.
-- ----------------------------------------------------------------------------
-- Closes a real gap: a "student" with no parent account has no session, so
-- listChildren()/verify_child_pin (both RLS-scoped to an authenticated
-- parent) could never resolve which child a code belongs to. This function
-- is the anon-safe equivalent: it is the ONLY way an unauthenticated caller
-- can ever read or touch public.children.
--
-- WHY SECURITY DEFINER: anon has zero grants on public.children — no table
-- grant, no column grant, no RLS policy (see 20260623120000_classyx_app_core
-- and 20260623122000_classyx_pin_column_grants). This function must run as
-- its owner to read pin_hash (to verify the code) and to write it (to rotate
-- the code). It is deliberately narrow in what that elevated privilege is
-- used for:
--   * it takes a single opaque 6-character code, nothing else from the caller;
--   * it only ever compares that code against the bcrypt hash of EVERY child
--     row looking for a match (bcrypt hashes are salted, so this can't be an
--     indexed lookup — fine at this table's expected scale);
--   * on a match it returns only id/name/family_id — never pin_hash, never
--     any other column, never any other table;
--   * on a match it immediately rotates that one row's code so the same code
--     can never be redeemed twice;
--   * on no match (or a malformed code) it raises, returning nothing.
-- It is granted EXECUTE to anon ONLY — not to authenticated or public — since
-- a signed-in parent has their own RLS-scoped path and should never need
-- this unscoped lookup-by-code.
-- ============================================================================

create or replace function public.redeem_child_code(code text)
returns table (child_id uuid, child_name text, family_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  matched record;
  new_code text;
begin
  if code is null or code !~ '^[a-z0-9]{6}$' then
    raise exception 'Invalid or expired code' using errcode = '22023';
  end if;

  -- Lock the matching row (if any) for the rest of this transaction, so a
  -- second concurrent redemption of the same code cannot also match it
  -- before this one rotates the hash below.
  select c.id, c.name, c.family_id
    into matched
    from public.children c
    where c.pin_hash is not null
      and extensions.crypt(code, c.pin_hash) = c.pin_hash
    limit 1
    for update of c;

  if matched.id is null then
    raise exception 'Invalid or expired code' using errcode = '22023';
  end if;

  -- Rotate immediately so this code can never be redeemed again. Uses
  -- gen_random_bytes (not the PIN-style gen_salt/crypt helpers) purely to
  -- pick 6 random alphanumeric characters, mapped onto the same
  -- lowercase-alphanumeric alphabet the client uses (generateChildCode in
  -- src/app/api.js), then hashed the normal way for storage.
  select string_agg(
           substr('abcdefghijklmnopqrstuvwxyz0123456789',
                  (get_byte(extensions.gen_random_bytes(6), i) % 36) + 1, 1),
           ''
         )
    into new_code
    from generate_series(0, 5) i;

  update public.children
    set pin_hash = extensions.crypt(new_code, extensions.gen_salt('bf'))
    where id = matched.id;

  child_id := matched.id;
  child_name := matched.name;
  family_id := matched.family_id;
  return next;
end;
$$;

comment on function public.redeem_child_code(text) is
  'SECURITY DEFINER: the only anon-safe way to read/rotate public.children. '
  'Takes an opaque 6-char code, matches it against pin_hash, returns '
  'id/name/family_id only, and rotates the code on success. Granted to anon '
  'only — never authenticated/public.';

revoke all on function public.redeem_child_code(text) from public, authenticated;
grant execute on function public.redeem_child_code(text) to anon;
