-- Soft delete for atlas_assets (30-day trash workflow)
-- Adds a deleted_at timestamp column. Items with deleted_at != null are in
-- the trash. The admin UI can restore or hard-delete them. The public_read
-- policy is updated so deleted items never appear on the front-end.

alter table public.atlas_assets
  add column if not exists deleted_at timestamptz;

create index if not exists idx_atlas_assets_deleted_at
  on public.atlas_assets(deleted_at)
  where deleted_at is not null;

-- Replace the public_read policy so deleted rows are hidden from non-admin
-- (admin write FOR ALL policy with public.is_admin() still lets admins
-- see trashed items so they can restore/purge).
drop policy if exists atlas_assets_public_read on public.atlas_assets;
create policy atlas_assets_public_read on public.atlas_assets
  for select using (
    (visibility = 'free' or is_preview = true) and deleted_at is null
  );

-- Helper function: purge atlas_assets soft-deleted more than `older_than`.
-- Storage files are NOT cleaned up by this function (no SQL access to the
-- Storage API); the admin UI's "永久删除" button or an Edge Function should
-- handle file removal. Run manually from SQL Editor when needed:
--   select public.purge_old_atlas_assets();         -- default: > 30 days
--   select public.purge_old_atlas_assets('7 days'); -- override
create or replace function public.purge_old_atlas_assets(
  older_than interval default '30 days'
)
returns bigint
language sql
security definer
set search_path = public
as $$
  with d as (
    delete from public.atlas_assets
    where deleted_at is not null
      and deleted_at < now() - older_than
    returning id
  )
  select count(*) from d;
$$;
