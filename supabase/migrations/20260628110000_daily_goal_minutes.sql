-- ============================================================================
-- Daily study goal — per-child, with the bcrypt redemption RPC updated to
-- return it (sessionStorage needs it without a separate authenticated query).
-- ============================================================================

alter table public.children
  add column if not exists daily_goal_minutes integer not null default 30
    check (daily_goal_minutes > 0);

comment on column public.children.daily_goal_minutes is
  'Per-child daily study goal in minutes, shown as a progress ring on the dashboard and an XP bar on the study page. Defaults to 30.';

-- Column-level grants follow the same narrow model as 20260623122000_classyx_pin_column_grants:
-- authenticated gets explicit SELECT/UPDATE on this column; anon gets nothing
-- direct (it only ever sees this via the SECURITY DEFINER redeem_child_code below).
grant select (daily_goal_minutes) on public.children to authenticated;
grant update (daily_goal_minutes) on public.children to authenticated;

-- redeem_child_code must now also hand back daily_goal_minutes so an
-- account-less child's session (sessionStorage) has it without a follow-up
-- query anon has no grant to make. Return type is changing, so the function
-- must be dropped and recreated rather than CREATE OR REPLACE'd.
drop function if exists public.redeem_child_code(text);

create function public.redeem_child_code(code text)
returns table (child_id uuid, child_name text, family_id uuid, daily_goal_minutes int)
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
  select c.id, c.name, c.family_id, c.daily_goal_minutes
    into matched
    from public.children c
    where c.pin_hash is not null
      and extensions.crypt(code, c.pin_hash) = c.pin_hash
    limit 1
    for update of c;

  if matched.id is null then
    raise exception 'Invalid or expired code' using errcode = '22023';
  end if;

  -- Rotate immediately so this code can never be redeemed again.
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
  daily_goal_minutes := matched.daily_goal_minutes;
  return next;
end;
$$;

comment on function public.redeem_child_code(text) is
  'SECURITY DEFINER: the only anon-safe way to read/rotate public.children. '
  'Takes an opaque 6-char code, matches it against pin_hash, returns '
  'id/name/family_id/daily_goal_minutes only, and rotates the code on '
  'success. Granted to anon only — never authenticated/public.';

revoke all on function public.redeem_child_code(text) from public, authenticated;
grant execute on function public.redeem_child_code(text) to anon;
