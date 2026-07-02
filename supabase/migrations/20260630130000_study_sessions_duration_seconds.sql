-- ============================================================================
-- study_sessions.duration_seconds — exact, unrounded session length.
-- ----------------------------------------------------------------------------
-- duration_minutes is rounded (and floored to a minimum of 1 for the anon
-- child path — see elapsedMinutes() in study.js) so short sessions don't
-- vanish from analytics history. That same flooring made the dashboard's
-- daily-goal ring overcount: two 5-second sessions would show as 2 minutes
-- of progress. duration_seconds stores the real, unrounded value so the
-- goal ring can compute SUM(duration_seconds) / 60 instead. duration_minutes
-- is unchanged and still drives the analytics history view.
-- ============================================================================

alter table public.study_sessions
  add column if not exists duration_seconds int;

comment on column public.study_sessions.duration_seconds is
  'Exact session length in seconds (unrounded, unfloored). Used for the '
  'dashboard daily-goal ring; duration_minutes (rounded, floored to a '
  'minimum of 1) remains the source for analytics history display.';

-- Update save_child_session to also accept/store the exact seconds.
create or replace function public.save_child_session(
  p_child_id uuid,
  p_subject text,
  p_duration_minutes int,
  p_duration_seconds int default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.children where id = p_child_id) then
    raise exception 'child not found' using errcode = '42501';
  end if;

  if not exists (select 1 from public.active_sessions where child_id = p_child_id) then
    raise exception 'no active session for this child' using errcode = '42501';
  end if;

  if p_duration_minutes is null or p_duration_minutes < 0 or p_duration_minutes > 1440 then
    raise exception 'invalid duration' using errcode = '22023';
  end if;

  if p_duration_seconds is not null and (p_duration_seconds < 0 or p_duration_seconds > 86400) then
    raise exception 'invalid duration' using errcode = '22023';
  end if;

  insert into public.study_sessions (child_id, started_at, ended_at, duration_minutes, duration_seconds, subject)
  values (
    p_child_id,
    now() - (p_duration_minutes || ' minutes')::interval,
    now(),
    p_duration_minutes,
    coalesce(p_duration_seconds, p_duration_minutes * 60),
    p_subject
  );
end;
$$;

comment on function public.save_child_session(uuid, text, int, int) is
  'SECURITY DEFINER: lets an account-less (anon) child record a finished '
  'study session, since anon has no RLS policy on study_sessions directly. '
  'Authorization is re-derived from a live active_sessions row for '
  'p_child_id (created by startPresence() on code redemption, deleted on '
  'tab close) — proof the caller just redeemed that child''s code, not a '
  'stranger who merely knows the child_id. Granted to anon only.';

revoke all on function public.save_child_session(uuid, text, int, int) from public, authenticated;
grant execute on function public.save_child_session(uuid, text, int, int) to anon;

-- Drop the old 3-arg overload now that callers pass 4 args.
drop function if exists public.save_child_session(uuid, text, int);
