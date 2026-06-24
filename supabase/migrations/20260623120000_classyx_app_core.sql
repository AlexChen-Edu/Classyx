-- ============================================================================
-- Classyx core app schema
-- ----------------------------------------------------------------------------
-- AI study app: parents sign up, create child profiles, children upload notes
-- and get AI-generated flashcards + study guides, parents see a progress
-- dashboard.
--
-- SECURITY MODEL (read this before changing anything)
-- ----------------------------------------------------------------------------
-- * The PARENT is the ONLY authenticated principal (Supabase Auth user).
--   Children do NOT have their own accounts — a child is just a row linked to a
--   family. The study experience runs inside the parent's authenticated
--   session on a shared/family device (a "profile selector", like streaming
--   apps).
-- * The RLS boundary is auth.uid() === families.parent_id. Every row in every
--   table is reachable only by transitively proving it belongs to a family the
--   current user owns. There are NO "allow all" / USING(true) policies.
-- * The 4-digit PIN is a PROFILE LOCK, not the security boundary. It is stored
--   as a bcrypt hash (never the raw PIN), is never exposed to the browser
--   (column SELECT is revoked), and is set/verified only through SECURITY
--   DEFINER functions that re-check family ownership.
-- * The anon role gets NO policies on any of these tables -> RLS denies it by
--   default. The waitlist table and send-confirmation function are untouched.
-- * The generate-content Edge Function uses the service_role key (bypasses
--   RLS) but independently verifies the caller's JWT + ownership before doing
--   any work. See supabase/functions/generate-content/index.ts.
-- ============================================================================

-- pgcrypto gives us crypt()/gen_salt() for bcrypt PIN hashing.
create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- TABLES
-- ============================================================================

-- families ------------------------------------------------------------------
create table if not exists public.families (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid not null references auth.users (id) on delete cascade,
  plan       text not null default 'student' check (plan in ('student', 'family')),
  created_at timestamptz not null default now(),
  -- One family per parent keeps the ownership model simple and unambiguous.
  constraint families_parent_id_key unique (parent_id)
);
comment on table public.families is 'A parent account and its plan. parent_id = auth.users.id is the RLS root.';

-- children ------------------------------------------------------------------
create table if not exists public.children (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  grade      text,
  -- Stores a bcrypt hash of the 4-digit PIN, never the raw PIN. Column SELECT
  -- is revoked below so the hash never reaches the browser. Nullable: a child
  -- can exist before a PIN is set.
  pin_hash   text,
  created_at timestamptz not null default now()
);
comment on table public.children is 'Child study profiles under a family. No auth account; pin_hash gates profile access.';
comment on column public.children.pin_hash is 'bcrypt hash of the 4-digit PIN. SELECT revoked from clients; set/checked via SECURITY DEFINER fns.';

-- study_sessions ------------------------------------------------------------
create table if not exists public.study_sessions (
  id               uuid primary key default gen_random_uuid(),
  child_id         uuid not null references public.children (id) on delete cascade,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_minutes int check (duration_minutes >= 0),
  subject          text,
  created_at       timestamptz not null default now()
);
comment on table public.study_sessions is 'One row per study sitting; powers the parent dashboard time/streak stats.';

-- uploads -------------------------------------------------------------------
create table if not exists public.uploads (
  id         uuid primary key default gen_random_uuid(),
  child_id   uuid not null references public.children (id) on delete cascade,
  file_path  text not null,                 -- path in the private "uploads" Storage bucket
  subject    text,
  processed  boolean not null default false,
  -- Records a generation failure so the UI can show a retry/error state.
  error      text,
  created_at timestamptz not null default now()
);
comment on table public.uploads is 'A note file (image/PDF) a child uploaded. The Edge Function flips processed=true.';

-- flashcards ----------------------------------------------------------------
create table if not exists public.flashcards (
  id         uuid primary key default gen_random_uuid(),
  upload_id  uuid references public.uploads (id) on delete cascade,
  child_id   uuid not null references public.children (id) on delete cascade,
  question   text not null,
  answer     text not null,
  created_at timestamptz not null default now()
);
comment on table public.flashcards is 'AI-generated Q/A pairs from an upload.';

-- study_guides --------------------------------------------------------------
create table if not exists public.study_guides (
  id         uuid primary key default gen_random_uuid(),
  upload_id  uuid references public.uploads (id) on delete cascade,
  child_id   uuid not null references public.children (id) on delete cascade,
  -- Stores the structured guide as a JSON string:
  -- { "summary": "...", "key_concepts": ["..."], "practice_questions": ["..."] }
  -- Kept as text per spec; parsed/rendered client-side.
  content    text not null,
  subject    text,
  created_at timestamptz not null default now()
);
comment on table public.study_guides is 'AI-generated study guide (JSON-in-text) from an upload.';

-- quiz_results --------------------------------------------------------------
create table if not exists public.quiz_results (
  id           uuid primary key default gen_random_uuid(),
  child_id     uuid not null references public.children (id) on delete cascade,
  flashcard_id uuid references public.flashcards (id) on delete set null,
  correct      boolean not null,
  answered_at  timestamptz not null default now()
);
comment on table public.quiz_results is 'Self-test outcomes; powers dashboard accuracy stats.';

-- Foreign-key indexes (the performance advisor flags unindexed FKs).
create index if not exists idx_children_family_id        on public.children (family_id);
create index if not exists idx_study_sessions_child_id   on public.study_sessions (child_id);
create index if not exists idx_uploads_child_id          on public.uploads (child_id);
create index if not exists idx_flashcards_child_id       on public.flashcards (child_id);
create index if not exists idx_flashcards_upload_id      on public.flashcards (upload_id);
create index if not exists idx_study_guides_child_id     on public.study_guides (child_id);
create index if not exists idx_study_guides_upload_id    on public.study_guides (upload_id);
create index if not exists idx_quiz_results_child_id     on public.quiz_results (child_id);
create index if not exists idx_quiz_results_flashcard_id on public.quiz_results (flashcard_id);

-- ============================================================================
-- OWNERSHIP HELPERS (SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- These run as the function owner so they can resolve ownership without
-- recursively triggering RLS on the joined tables. They ONLY ever compare
-- against auth.uid(), so they cannot be used to escalate.
-- ============================================================================

create or replace function public.owns_family(fam uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.families f
    where f.id = fam and f.parent_id = auth.uid()
  );
$$;

create or replace function public.owns_child(child uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.children c
    join public.families f on f.id = c.family_id
    where c.id = child and f.parent_id = auth.uid()
  );
$$;

-- ============================================================================
-- PIN: set + verify (SECURITY DEFINER, ownership-checked)
-- ----------------------------------------------------------------------------
-- The browser never sees pin_hash. To set or check a PIN, callers use these
-- functions, which re-verify the child belongs to the caller's family.
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
  if new_pin is null or new_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN must be exactly 4 digits' using errcode = '22023';
  end if;
  update public.children
    set pin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf'))
    where id = child;
end;
$$;

create or replace function public.verify_child_pin(child uuid, attempt text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  stored text;
begin
  if not public.owns_child(child) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select pin_hash into stored from public.children where id = child;
  -- No PIN set -> treat as open profile (parents can leave it blank).
  if stored is null then
    return true;
  end if;
  if attempt is null or attempt = '' then
    return false;
  end if;
  return extensions.crypt(attempt, stored) = stored;
end;
$$;

-- Lock down who may call these.
revoke all on function public.owns_family(uuid)            from public, anon;
revoke all on function public.owns_child(uuid)             from public, anon;
revoke all on function public.set_child_pin(uuid, text)    from public, anon;
revoke all on function public.verify_child_pin(uuid, text) from public, anon;
grant execute on function public.set_child_pin(uuid, text)    to authenticated;
grant execute on function public.verify_child_pin(uuid, text) to authenticated;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Enabled on every table. Policies target the `authenticated` role only and
-- always scope to the owning family. No anon policies => anon is fully denied.
-- ============================================================================

alter table public.families      enable row level security;
alter table public.children      enable row level security;
alter table public.study_sessions enable row level security;
alter table public.uploads       enable row level security;
alter table public.flashcards    enable row level security;
alter table public.study_guides  enable row level security;
alter table public.quiz_results  enable row level security;

-- families: a user manages exactly their own family row.
drop policy if exists "families: owner all" on public.families;
create policy "families: owner all" on public.families
  for all to authenticated
  using (parent_id = auth.uid())
  with check (parent_id = auth.uid());

-- children: rows under a family the user owns.
drop policy if exists "children: owner all" on public.children;
create policy "children: owner all" on public.children
  for all to authenticated
  using (public.owns_family(family_id))
  with check (public.owns_family(family_id));

-- study_sessions / uploads / flashcards / study_guides / quiz_results:
-- rows under a child the user owns.
drop policy if exists "study_sessions: owner all" on public.study_sessions;
create policy "study_sessions: owner all" on public.study_sessions
  for all to authenticated
  using (public.owns_child(child_id))
  with check (public.owns_child(child_id));

drop policy if exists "uploads: owner all" on public.uploads;
create policy "uploads: owner all" on public.uploads
  for all to authenticated
  using (public.owns_child(child_id))
  with check (public.owns_child(child_id));

drop policy if exists "flashcards: owner all" on public.flashcards;
create policy "flashcards: owner all" on public.flashcards
  for all to authenticated
  using (public.owns_child(child_id))
  with check (public.owns_child(child_id));

drop policy if exists "study_guides: owner all" on public.study_guides;
create policy "study_guides: owner all" on public.study_guides
  for all to authenticated
  using (public.owns_child(child_id))
  with check (public.owns_child(child_id));

drop policy if exists "quiz_results: owner all" on public.quiz_results;
create policy "quiz_results: owner all" on public.quiz_results
  for all to authenticated
  using (public.owns_child(child_id))
  with check (public.owns_child(child_id));

-- Hide the PIN hash from clients entirely. Clients must SELECT explicit
-- columns on public.children (never SELECT *), since pin_hash is not granted.
revoke select (pin_hash) on public.children from anon, authenticated;

-- ============================================================================
-- STORAGE: private "uploads" bucket + per-family folder isolation
-- ----------------------------------------------------------------------------
-- Files live at  <family_id>/<child_id>/<uuid>-<filename>. A user may only
-- read/write objects whose first path segment is a family they own. The Edge
-- Function reads files with the service_role key, bypassing these policies.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

drop policy if exists "uploads bucket: owner read"   on storage.objects;
drop policy if exists "uploads bucket: owner write"  on storage.objects;
drop policy if exists "uploads bucket: owner update" on storage.objects;
drop policy if exists "uploads bucket: owner delete" on storage.objects;

create policy "uploads bucket: owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'uploads'
    and public.owns_family(nullif((storage.foldername(name))[1], '')::uuid)
  );

create policy "uploads bucket: owner write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and public.owns_family(nullif((storage.foldername(name))[1], '')::uuid)
  );

create policy "uploads bucket: owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'uploads'
    and public.owns_family(nullif((storage.foldername(name))[1], '')::uuid)
  );

create policy "uploads bucket: owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'uploads'
    and public.owns_family(nullif((storage.foldername(name))[1], '')::uuid)
  );
