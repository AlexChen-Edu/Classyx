# Classyx — Landing Page & Waitlist

A single-page marketing site for **Classyx**, an AI-powered study app for students with a
parent accountability dashboard. Built with plain HTML/CSS/vanilla JS on a minimal **Vite**
setup, with a working email waitlist backed by **Supabase**.

The whole security model is built around one idea: **the public anon key is exposed (that's
normal and unavoidable for a browser app) — so the database itself is locked down with Row
Level Security so the exposed key can do exactly one thing: insert a single email.**

---

## Project structure

```
classyx/
├── index.html             # Page markup (all 8 sections)
├── package.json           # Scripts + deps (Vite, @supabase/supabase-js)
├── .env.example           # Template for env vars (safe to commit)
├── .env                   # Real values — YOU create this; git-ignored, never committed
├── .gitignore             # Ignores .env, node_modules, dist, …
├── README.md
└── src/
    ├── main.js            # Form logic, validation, smooth scroll, reveal-on-scroll
    ├── supabaseClient.js  # Creates the Supabase client from env vars only
    └── style.css          # Design system + all styles (mobile-first, responsive)
```

---

## Prerequisites

- **Node.js 18+** and npm — <https://nodejs.org> (LTS recommended)
- A **Supabase** project — <https://supabase.com>

> **Heads-up if this folder lives in OneDrive/Dropbox:** `node_modules` contains thousands of
> files and syncs poorly. Consider moving the project to a non-synced path (e.g. `C:\dev\classyx`)
> before running `npm install`, or exclude `node_modules` from sync.

---

## 1. Environment setup (`.env`)

Secrets are **never** hard-coded in `.js`/`.html`. They are read at build time from environment
variables prefixed with `VITE_` (the only prefix Vite exposes to client code).

```bash
cp .env.example .env
```

Then open `.env` and fill in your two **public** values:

```dotenv
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

Find them in the Supabase dashboard:

- **URL** → Project Settings → **Data API** → Project URL
- **anon key** → Project Settings → **API Keys** → `anon` / publishable key

> ⚠️ **Only the public anon key goes here.** Never put the `service_role` (secret) key in `.env`,
> in any front-end file, or anywhere it could reach the browser — it bypasses Row Level Security
> and would expose your entire database.

`.env` is listed in `.gitignore`, so it will not be committed. `.env.example` (placeholders only)
is committed so collaborators know what to fill in.

---

## 2. Create the Supabase table + RLS policy

Run this in the Supabase dashboard → **SQL Editor**. It is the exact schema this app expects.

```sql
-- 1) Table with database-level validation (don't trust the client alone)
create table public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  created_at  timestamptz not null default now(),
  constraint waitlist_email_format_chk check (
    char_length(email) <= 254
    and email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
  )
);

-- 2) Unique constraint on email (case-insensitive: Foo@x.com == foo@x.com)
create unique index waitlist_email_unique_idx on public.waitlist (lower(email));

-- 3) Turn on Row Level Security
alter table public.waitlist enable row level security;

-- 4) Defense in depth: strip default privileges from the public roles, then
--    grant back ONLY insert to anon. Even if a policy were ever misconfigured,
--    anon still has no privilege to read, update, or delete rows.
revoke all on public.waitlist from anon, authenticated;
grant insert on public.waitlist to anon;

-- 5) The one allowed action: anon may INSERT, and only a well-formed email.
--    No SELECT / UPDATE / DELETE policy exists, so RLS denies all of those.
create policy "anon can insert valid waitlist signups"
  on public.waitlist
  for insert
  to anon
  with check (
    char_length(email) <= 254
    and email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
  );
```

### Verify it (optional, recommended)

Run each block in the SQL Editor — they simulate the public/anon role:

```sql
-- anon CAN insert (should succeed)
begin; set local role anon;
insert into public.waitlist (email) values ('test@example.com');
rollback;

-- anon CANNOT read / update / delete (each should error: permission denied)
begin; set local role anon; select * from public.waitlist; rollback;
begin; set local role anon; update public.waitlist set email='x@x.com'; rollback;
begin; set local role anon; delete from public.waitlist; rollback;
```

You can also run **Advisors → Security** in the dashboard; the `waitlist` table should be clean.

---

## 3. Run locally

```bash
npm install
npm run dev
```

Open the printed URL (default <http://localhost:5173>). Submit the form — a row appears in
**Table Editor → waitlist** in your Supabase dashboard.

Production build / local preview of the build:

```bash
npm run build      # outputs static files to dist/
npm run preview    # serves dist/ locally
```

---

## 4. Deploy to Vercel

1. Push the repo to GitHub. **Confirm `.env` is _not_ in the commit** (it's git-ignored).
2. In Vercel → **New Project** → import the repo.
3. Framework preset: **Vite** (Build command `npm run build`, Output dir `dist`).
4. **Project Settings → Environment Variables** — add the same two keys:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   (Add them for Production + Preview. These are public values, but Vercel is still where they
   belong — not in the repo.)
5. **Deploy.**

No CORS setup is needed: Supabase's REST API allows browser origins by default, and only the
locked-down anon key is used.

---

## Security model (how this is safe)

| Requirement | How it's handled |
|---|---|
| Only the public anon key in the frontend | `src/supabaseClient.js` reads `import.meta.env.VITE_SUPABASE_ANON_KEY`; `service_role` is never referenced anywhere. |
| No secrets in code | URL + key come from env vars only; nothing hard-coded in `.js`/`.html`. `.env` is git-ignored. |
| RLS enabled, insert-only for anon | `enable row level security` + a single `INSERT` policy. No read/update/delete policy exists, **and** those privileges are `REVOKE`d from `anon`. |
| Can't read the email list with the public key | Verified: `SELECT` as `anon` → `permission denied`. |
| Client + server validation | Regex check in `main.js` **and** a DB `CHECK` constraint + the RLS `WITH CHECK`. |
| No duplicate emails | Case-insensitive unique index on `lower(email)`. |
| Friendly, non-leaky errors | UI shows generic messages only. Raw error objects / DB details are never printed to the UI or console. A duplicate signup shows the **same** success message as a new one, so the form can't be used to discover which emails are already registered (no enumeration). |

---

## ⚠️ Known limitation: rate limiting / abuse protection

Supabase's free tier provides **some** platform-level protection (basic network/infra limits),
but it is **not a full application-level rate limiter**. The waitlist insert endpoint is public
by design, so:

- The unique index makes spamming the **same** email a harmless no-op, and the `CHECK` constraint
  rejects malformed input.
- However, a determined actor could still insert many **distinct** fake addresses.

This is flagged as a known limitation rather than silently ignored. For production hardening,
consider one or more of:

- A CAPTCHA / **Cloudflare Turnstile** challenge on the form.
- Putting the insert behind a **Supabase Edge Function** that enforces per-IP rate limits.
- A reverse proxy / WAF (e.g. **Cloudflare**) in front of the site.
- Supabase's paid network restrictions / rate-limiting features.

---

## Tech

- **Vite** — dev server + build
- **@supabase/supabase-js** — Supabase client
- **Inter** + **Space Grotesk** (Google Fonts)
- No CSS framework — a small hand-rolled design system in `src/style.css`
