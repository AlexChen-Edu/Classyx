-- Lets a parent deactivate their own account from Settings > Account. Login
-- (getFamily, called right after sign-in) checks this and blocks access with
-- a clear message instead of silently signing them into a "dead" dashboard.
alter table public.families
  add column if not exists is_deactivated boolean not null default false;
