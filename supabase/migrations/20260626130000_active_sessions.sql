-- ============================================================================
-- active_sessions — live "is this child studying right now" presence.
-- ----------------------------------------------------------------------------
-- One row per child (child_id is UNIQUE), upserted when a study session
-- starts, pinged every 30s while it's open, deleted on tab close/navigation.
-- A row whose last_ping is older than 2 minutes is considered STALE by every
-- reader (dashboard.js) regardless of whether the delete-on-unload actually
-- fired — that staleness check is the real correctness guarantee here, since
-- unload cleanup (sendBeacon) is inherently best-effort (a killed process,
-- a lost network blip, etc. can all skip it).
--
-- WHY ANON CAN WRITE: students using a parent-generated code have no Supabase
-- Auth session at all (see redeem_child_code / supabaseAnon), so there is no
-- identity to scope an INSERT/UPDATE policy to. The anon policies below are
-- intentionally unscoped (any child_id). This is a deliberate, narrow
-- trade-off: anon can write/refresh presence for any child_id it knows, but
-- can NEVER read this table (no anon SELECT grant/policy at all) and can
-- never write to any OTHER table this way — presence rows carry no
-- sensitive data beyond "this child is online", and the same exposure
-- already exists implicitly via the rotating 6-character code system.
-- ============================================================================

create table if not exists public.active_sessions (
  id         uuid primary key default gen_random_uuid(),
  child_id   uuid not null unique references public.children (id) on delete cascade,
  started_at timestamptz not null default now(),
  last_ping  timestamptz not null default now()
);

comment on table public.active_sessions is
  'Live presence, one row per child (upsert on child_id). last_ping older '
  'than 2 minutes = stale; readers must treat it as "not active" even if the '
  'row was never deleted.';

create index if not exists idx_active_sessions_child_id on public.active_sessions (child_id);

alter table public.active_sessions enable row level security;

-- Only the owning parent can ever read presence.
drop policy if exists "active_sessions: parent select" on public.active_sessions;
create policy "active_sessions: parent select" on public.active_sessions
  for select to authenticated
  using (public.owns_child(child_id));

-- Anon (account-less students) write their own presence. Unscoped by design —
-- see the comment above. No anon SELECT or DELETE policy/grant exists at all.
drop policy if exists "active_sessions: anon insert" on public.active_sessions;
create policy "active_sessions: anon insert" on public.active_sessions
  for insert to anon
  with check (true);

drop policy if exists "active_sessions: anon update" on public.active_sessions;
create policy "active_sessions: anon update" on public.active_sessions
  for update to anon
  using (true)
  with check (true);

-- Table grants are a SEPARATE layer from RLS — without these, every anon
-- write above would still fail with "permission denied for table".
revoke all on public.active_sessions from anon, authenticated;
grant select, insert, update on public.active_sessions to authenticated;
grant insert, update on public.active_sessions to anon;

-- ============================================================================
-- end_active_session(p_child_id) — anon-safe presence cleanup.
-- ----------------------------------------------------------------------------
-- navigator.sendBeacon can only send a POST with no custom headers, so it
-- cannot issue a real HTTP DELETE against the REST table endpoint. This tiny
-- SECURITY DEFINER function is the POST-able equivalent: it deletes exactly
-- one row, by child_id, nothing else. Anon has no DELETE grant/policy on the
-- table itself — this function is the only delete path, intentionally narrow.
-- ============================================================================

create or replace function public.end_active_session(p_child_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.active_sessions where child_id = p_child_id;
$$;

comment on function public.end_active_session(uuid) is
  'SECURITY DEFINER: deletes the active_sessions row for one child_id. The '
  'only delete path for this table — called via navigator.sendBeacon on tab '
  'close, which cannot issue a real DELETE request. Granted to anon and '
  'authenticated (both trust paths can end their own presence).';

revoke all on function public.end_active_session(uuid) from public;
grant execute on function public.end_active_session(uuid) to anon, authenticated;
