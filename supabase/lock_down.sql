-- Require sign-in to change the sheet inventory (run after schema.sql).
-- Afterwards only emails in public.editors can add or change sheets; anyone can still view.
-- Also set requireSignIn: true in web/config.js so the page shows the sign-in box.
-- To open editing again, re-run schema.sql.

drop policy if exists "sheets editable"        on public.sheets;
drop policy if exists "sheet_regions editable" on public.sheet_regions;

create policy "sheets editable" on public.sheets
  for all to authenticated using (public.is_editor()) with check (public.is_editor());
create policy "sheet_regions editable" on public.sheet_regions
  for all to authenticated using (public.is_editor()) with check (public.is_editor());

revoke insert, update, delete on public.sheets, public.sheet_regions from anon;
grant insert, update, delete on public.sheets, public.sheet_regions to authenticated;
