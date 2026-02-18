-- MIGRATION_20260107_SPONSOR_LOGOS.sql
-- 新增：赞助商 Logo 上传所需的 Storage bucket + RLS policies
-- 运行位置：Supabase Dashboard -> SQL Editor

-- 1) 创建公开 bucket（用于首页/Frontier 展示 logo）
insert into storage.buckets (id, name, public)
values ('sponsor_logos', 'sponsor_logos', true)
on conflict (id) do nothing;

-- 2) storage.objects policies（允许所有人读取；仅 admin/super_admin 可写）
drop policy if exists "sponsor_logos_public_read" on storage.objects;
create policy "sponsor_logos_public_read"
  on storage.objects for select
  using ( bucket_id = 'sponsor_logos' );

drop policy if exists "sponsor_logos_admin_insert" on storage.objects;
create policy "sponsor_logos_admin_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'sponsor_logos'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin','super_admin')
    )
  );

drop policy if exists "sponsor_logos_admin_update" on storage.objects;
create policy "sponsor_logos_admin_update"
  on storage.objects for update
  using (
    bucket_id = 'sponsor_logos'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin','super_admin')
    )
  )
  with check (
    bucket_id = 'sponsor_logos'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin','super_admin')
    )
  );

drop policy if exists "sponsor_logos_admin_delete" on storage.objects;
create policy "sponsor_logos_admin_delete"
  on storage.objects for delete
  using (
    bucket_id = 'sponsor_logos'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin','super_admin')
    )
  );
