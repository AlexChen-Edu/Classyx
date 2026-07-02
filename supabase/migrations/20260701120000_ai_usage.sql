-- ============================================================================
-- AI usage tracking: one row per AI credit consumed, per child.
-- ----------------------------------------------------------------------------
-- Powers the monthly credit limit system. The Edge Function inserts a row
-- after every successful OpenAI call; parents can read their family's usage
-- on the dashboard. Anon (account-less) children insert via the same
-- has_live_session() proof already used by uploads and quiz_results.
-- ============================================================================

create table public.ai_usage (
  id        uuid        primary key default gen_random_uuid(),
  child_id  uuid        not null references public.children(id)  on delete cascade,
  family_id uuid        not null references public.families(id)  on delete cascade,
  used_at   timestamptz not null default now()
);

comment on table public.ai_usage is
  'One row per AI credit consumed. The Edge Function writes this after every '
  'successful OpenAI call. The family plan controls the monthly limit.';

alter table public.ai_usage enable row level security;

-- Parents can read all usage for their family
create policy "ai_usage: parent select" on public.ai_usage
  for select to authenticated
  using (public.owns_family(family_id));

-- Account-less children insert usage if they have a live session
create policy "ai_usage: anon insert" on public.ai_usage
  for insert to anon
  with check (public.has_live_session(child_id));

-- Authenticated callers (parent-session children) insert for their own child
create policy "ai_usage: authenticated insert" on public.ai_usage
  for insert to authenticated
  with check (public.owns_child(child_id));

-- Fast monthly count by child
create index ai_usage_child_month_idx on public.ai_usage (child_id, used_at);
-- FK index (performance advisor)
create index ai_usage_family_id_idx   on public.ai_usage (family_id);
