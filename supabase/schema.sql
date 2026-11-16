-- RosCAM sheet inventory
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again; it only creates what is missing and resets the access rules.
--
-- Tables
--   sheets         one row per physical sheet, keyed by the ID written on it in sharpie
--   sheet_regions  areas of a sheet that are off limits: measured by hand ('blocked')
--                  or recorded automatically when RosCAM cuts a part ('cut')
--   editors        emails allowed to change the inventory once it is locked down
--
-- Editing is OPEN: anyone using RosCAM can add and change sheets (no sign-in).
-- To require sign-in later, run supabase/lock_down.sql (and set requireSignIn in web/config.js).
--
-- All lengths are inches, measured from the sheet's lower-left corner.

create table if not exists public.sheets (
  id          text primary key check (length(trim(id)) between 1 and 40),
  material    text not null,                       -- RosCAM material id, e.g. 'aluminum'
  thickness   text not null,                       -- RosCAM thickness label, e.g. '1/8'
  width       numeric not null default 24 check (width > 0 and width <= 120),
  height      numeric not null default 48 check (height > 0 and height <= 120),
  status      text not null default 'active' check (status in ('active', 'used_up')),
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.sheet_regions (
  id          uuid primary key default gen_random_uuid(),
  sheet_id    text not null references public.sheets(id) on update cascade on delete cascade,
  kind        text not null check (kind in ('blocked', 'cut')),
  label       text not null default '',
  polygon     jsonb not null check (jsonb_typeof(polygon) = 'array' and jsonb_array_length(polygon) >= 3),
  created_at  timestamptz not null default now(),
  created_by  text not null default coalesce(auth.jwt() ->> 'email', '')
);
create index if not exists sheet_regions_sheet_id on public.sheet_regions(sheet_id);

create table if not exists public.editors (
  email text primary key
);

-- Keep updated_at current, and bump the sheet when its regions change.
create or replace function public.touch_sheet() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'sheets' then
    new.updated_at := now();
    return new;
  end if;
  update public.sheets set updated_at = now()
   where id = coalesce(new.sheet_id, old.sheet_id);
  return coalesce(new, old);
end $$;

drop trigger if exists sheets_touch on public.sheets;
create trigger sheets_touch before update on public.sheets
  for each row execute function public.touch_sheet();
drop trigger if exists sheet_regions_touch on public.sheet_regions;
create trigger sheet_regions_touch after insert or update or delete on public.sheet_regions
  for each row execute function public.touch_sheet();

-- Is the signed-in user on the editors list?
create or replace function public.is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.editors e
     where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_editor() from public;
grant execute on function public.is_editor() to anon, authenticated;

-- Row level security. For now anyone can read AND change the inventory (open editing).
-- supabase/lock_down.sql replaces the "editable" rules with editors-only ones.
alter table public.sheets        enable row level security;
alter table public.sheet_regions enable row level security;
alter table public.editors       enable row level security;   -- no policies: not reachable from the web

drop policy if exists "sheets readable"          on public.sheets;
drop policy if exists "sheets editable"          on public.sheets;
drop policy if exists "sheet_regions readable"   on public.sheet_regions;
drop policy if exists "sheet_regions editable"   on public.sheet_regions;

create policy "sheets readable" on public.sheets
  for select to anon, authenticated using (true);
create policy "sheets editable" on public.sheets
  for all to anon, authenticated using (true) with check (true);
create policy "sheet_regions readable" on public.sheet_regions
  for select to anon, authenticated using (true);
create policy "sheet_regions editable" on public.sheet_regions
  for all to anon, authenticated using (true) with check (true);

revoke all on public.sheets, public.sheet_regions, public.editors from anon, authenticated;
grant select, insert, update, delete on public.sheets, public.sheet_regions to anon, authenticated;

-- Editors used once editing is locked down (supabase/lock_down.sql). Create each one under
-- Authentication -> Users -> Add user (same email, a password, "Auto Confirm User" ticked).
insert into public.editors (email) values ('roscam@frc5572.org')
  on conflict (email) do nothing;
