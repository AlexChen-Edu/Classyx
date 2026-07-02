-- ============================================================================
-- save_child_session(p_child_id, p_subject, p_duration_minutes) — lets an
-- account-less (anon) child record a finished study session.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS: anon has no RLS policy on study_sessions at all (only the
-- parent-authenticated "study_sessions: owner all" policy exists), so a
-- direct anon INSERT is denied with 42501. That's intentional — broadening
-- anon's direct table access would let any caller who has ever seen ONE
-- child_id read or write arbitrary session history for it, since anon has no
-- identity to scope a normal RLS policy to.
--
-- SECURITY MODEL: this function re-derives authorization the same way
-- active_sessions already does for presence — it requires a LIVE
-- active_sessions row for p_child_id, which only ever exists because
-- startPresence() created one right after a code was successfully redeemed
-- (via redeem_child_code) and is deleted within ~2 minutes of the tab
-- closing (end_active_session). Requiring that row to exist proves the
-- caller is the same browser session that just redeemed that child's code —
-- not a stranger who merely observed or guessed a child_id — without
-- needing anon to carry any identity of its own. study.js calls this BEFORE
-- it tears down the active_sessions row on tab close, so the check still
-- passes for that path.
--
-- This is still self-reported duration with no stronger proof than "the
-- client says so" — exactly the same trust level study.js's authenticated
-- touchSession() already has (it computes duration client-side from
-- Date.now() too). The 24-hour cap below is purely a sanity bound against a
-- malformed/runaway client value, not a security boundary.
-- ============================================================================

create or replace function public.save_child_session(
  p_child_id uuid,
  p_subject text,
  p_duration_minutes int
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

  insert into public.study_sessions (child_id, started_at, ended_at, duration_minutes, subject)
  values (
    p_child_id,
    now() - (p_duration_minutes || ' minutes')::interval,
    now(),
    p_duration_minutes,
    p_subject
  );
end;
$$;

comment on function public.save_child_session(uuid, text, int) is
  'SECURITY DEFINER: lets an account-less (anon) child record a finished '
  'study session, since anon has no RLS policy on study_sessions directly. '
  'Authorization is re-derived from a live active_sessions row for '
  'p_child_id (created by startPresence() on code redemption, deleted on '
  'tab close) — proof the caller just redeemed that child''s code, not a '
  'stranger who merely knows the child_id. Granted to anon only.';

revoke all on function public.save_child_session(uuid, text, int) from public, authenticated;
grant execute on function public.save_child_session(uuid, text, int) to anon;
