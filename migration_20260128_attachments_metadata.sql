-- MIGRATION_20260128_ATTACHMENTS_METADATA.sql
--
-- 目的：修复 Expert PPT/附件上传时出现的
--   "Could not find the 'mime' / 'name' / 'size' column of 'attachments' in the schema cache"
-- 通过统一 attachments 元数据字段为：
--   mime_type / original_name / size_bytes
--
-- 说明：
-- - 如果你已按新版 SUPABASE_SETUP.sql 建过 public.attachments，这个迁移可能什么都不会改（幂等）。
-- - 若你历史版本里用过 mime/name/size 旧字段，本迁移会尝试“动态”回填到新字段（不会因列不存在而报错）。
-- - 运行后建议在 Supabase Dashboard 点击一次 "Reload schema"（或等待 PostgREST 自动刷新）。

begin;

-- 1) Ensure modern metadata columns exist
alter table public.attachments add column if not exists mime_type text;
alter table public.attachments add column if not exists original_name text;
alter table public.attachments add column if not exists size_bytes bigint;

-- 2) Optional legacy backfill (dynamic SQL to avoid compile-time errors)
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'attachments' and column_name = 'mime'
  ) then
    execute $$
      update public.attachments
      set mime_type = coalesce(mime_type, mime)
      where mime_type is null and mime is not null
    $$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'attachments' and column_name = 'name'
  ) then
    execute $$
      update public.attachments
      set original_name = coalesce(original_name, name)
      where original_name is null and name is not null
    $$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'attachments' and column_name = 'size'
  ) then
    execute $$
      update public.attachments
      set size_bytes = coalesce(size_bytes, size)
      where size_bytes is null and size is not null
    $$;
  end if;
end $$;

-- 3) Best-effort PostgREST schema reload (if permissions block it, ignore)
do $$
begin
  perform pg_notify('pgrst', 'reload schema');
exception when others then
  null;
end $$;

commit;
