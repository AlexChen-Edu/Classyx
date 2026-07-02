-- ============================================================================
-- get_child_code(p_child_id) — parent-facing "show me my child's code".
-- ----------------------------------------------------------------------------
-- WHY THIS GENERATES A NEW CODE INSTEAD OF RETURNING THE EXISTING ONE:
-- children.pin_hash stores a bcrypt hash, not the plain-text code — bcrypt is
-- a one-way function, so the original code was never stored anywhere after
-- set_child_pin/redeem_child_code hashed it and is mathematically impossible
-- to recover from pin_hash. The only way to hand the parent something usable
-- is to generate a BRAND NEW code, hash and store it (overwriting pin_hash),
-- and return the new plain-text value in the same transaction. A side effect
-- of this — clicking "Show code" silently invalidates whatever code was
-- previously in use — is intentional, not a bug: it's the same one-code-at-
-- a-time, single-use-by-rotation model already used by redeem_child_code.
--
-- WHY SECURITY DEFINER: same reasoning as set_child_pin/verify_child_pin —
-- a parent has no direct grant on children.pin_hash (column SELECT/UPDATE is
-- revoked from every client role), so this must run as the function owner to
-- write the new hash. Ownership is re-verified via owns_child() before doing
-- anything, so a parent can only ever rotate a code for a child in their own
-- family. Granted to authenticated only — anon has no use for this (it has
-- no identity to own a child with) and is explicitly NOT granted.
-- ============================================================================

create or replace function public.get_child_code(p_child_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_code text;
begin
  if not public.owns_child(p_child_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Same random-code generation as redeem_child_code's rotation step: 6
  -- bytes from gen_random_bytes mapped onto the lowercase-alphanumeric
  -- alphabet (matches generateChildCode in src/app/api.js).
  select string_agg(
           substr('abcdefghijklmnopqrstuvwxyz0123456789',
                  (get_byte(extensions.gen_random_bytes(6), i) % 36) + 1, 1),
           ''
         )
    into new_code
    from generate_series(0, 5) i;

  update public.children
    set pin_hash = extensions.crypt(new_code, extensions.gen_salt('bf'))
    where id = p_child_id;

  return new_code;
end;
$$;

comment on function public.get_child_code(uuid) is
  'SECURITY DEFINER, ownership-checked via owns_child(). Generates and stores '
  'a brand-new code rather than returning the existing one, because pin_hash '
  'is a one-way bcrypt hash — the original plain-text code was never stored '
  'and cannot be recovered. Returning a freshly-generated code (and '
  'immediately overwriting pin_hash with its hash) is the only way to give '
  'the parent something to show their child; viewing the code therefore '
  'invalidates whatever code was previously in use. Granted to authenticated '
  'only.';

revoke all on function public.get_child_code(uuid) from public, anon;
grant execute on function public.get_child_code(uuid) to authenticated;
