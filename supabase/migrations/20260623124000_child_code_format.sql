-- ============================================================================
-- Switch the child profile lock from a 4-digit PIN to a 6-character
-- lowercase-alphanumeric code (e.g. "a3k9mz"), generated client-side with
-- crypto.getRandomValues() and rotated on every successful login.
-- ----------------------------------------------------------------------------
-- Only the format check inside set_child_pin() changes. Storage (bcrypt hash
-- in children.pin_hash), column grants, RLS, and verify_child_pin() all stay
-- exactly as they were — verify_child_pin() never validated a format, it just
-- compares against the stored hash, so 6-char codes already work there.
-- ============================================================================

create or replace function public.set_child_pin(child uuid, new_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.owns_child(child) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if new_pin is null or new_pin !~ '^[a-z0-9]{6}$' then
    raise exception 'Code must be exactly 6 lowercase letters/numbers' using errcode = '22023';
  end if;
  update public.children
    set pin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf'))
    where id = child;
end;
$$;
