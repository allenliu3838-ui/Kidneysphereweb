-- Atlas admin write RLS policies + storage policies
-- The original migration_20260514_atlas_pro.sql enabled RLS but only created
-- SELECT policies. As a result admins could not INSERT/UPDATE/DELETE atlas_*
-- rows, and the batch upload feature failed with:
--   "new row violates row-level security policy for table atlas_assets"
-- This migration grants admins (public.is_admin()) full write access to all
-- atlas_* tables, plus upload/manage access to the atlas storage buckets.

-- ============ Table-level admin write policies ============

drop policy if exists atlas_categories_admin_write on public.atlas_categories;
create policy atlas_categories_admin_write on public.atlas_categories
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists atlas_topics_admin_write on public.atlas_topics;
create policy atlas_topics_admin_write on public.atlas_topics
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists atlas_series_admin_write on public.atlas_series;
create policy atlas_series_admin_write on public.atlas_series
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists atlas_assets_admin_write on public.atlas_assets;
create policy atlas_assets_admin_write on public.atlas_assets
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists atlas_references_admin_write on public.atlas_references;
create policy atlas_references_admin_write on public.atlas_references
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============ Storage policies for atlas buckets ============
-- atlas_hd is private (signed URL access only). atlas_previews is public for
-- read. Both need admin-only write policies so non-admin users cannot upload.

drop policy if exists atlas_hd_admin_all on storage.objects;
create policy atlas_hd_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'atlas_hd' and public.is_admin())
  with check (bucket_id = 'atlas_hd' and public.is_admin());

drop policy if exists atlas_previews_admin_all on storage.objects;
create policy atlas_previews_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'atlas_previews' and public.is_admin())
  with check (bucket_id = 'atlas_previews' and public.is_admin());
