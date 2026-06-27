-- ============================================================================
-- active_sessions.paused_ms — cumulative time (ms) the study tab has spent
-- hidden during the current session, so readers can compute true active
-- time as (now - started_at) - paused_ms instead of raw wall-clock elapsed.
-- Written by the same anon ping path as last_ping (study.js pingPresence),
-- so it shares that path's grants/policies — no new grant needed.
-- ============================================================================

alter table public.active_sessions
  add column if not exists paused_ms bigint not null default 0;
