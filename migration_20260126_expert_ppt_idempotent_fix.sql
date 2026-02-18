-- KidneySphereAI
-- Expert PPT upload hotfix (idempotent)
--
-- Why this file exists:
-- 1) Many projects already have public.expert_ppts created by older migrations (with `section_key` + `tags TEXT`).
--    A later migration mistakenly assumed a different schema (e.g. `channel_id`, `tags TEXT[]`) which caused errors like:
--      ERROR: 42703: column "channel_id" does not exist
--
-- 2) Supabase Storage policies are frequently re-run; this file DROPs & recreates policies to avoid:
--      ERROR: 42710: policy "..." already exists
--
-- Safe to run multiple times.

begin;

-- -----------------------------------------------------------------------------
-- Helpers: role + doctor verification
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'super_admin'
  );
$$;

-- Unified doctor verified check.
-- Accepts ANY of:
--   - profiles.doctor_verified_at is not null
--   - profiles.role in ('doctor','admin','super_admin')
--   - doctor_verifications has approved/verified status for the user
create or replace function public.is_doctor_verified()
returns boolean
language sql
stable
as $$
  select (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and (
          p.doctor_verified_at is not null
          or p.role in ('doctor','admin','super_admin')
        )
    )
    or exists (
      select 1
      from public.doctor_verifications dv
      where dv.user_id = auth.uid()
        and (
          dv.verified_at is not null
          or dv.status in ('approved','passed','ok','verified','done')
        )
    )
  );
$$;

-- -----------------------------------------------------------------------------
-- Ensure table exists in the *current* schema used by expert-ppt.html / expertPpt.js
-- (section_key + tags TEXT). Do NOT assume channel_id or tags arrays.
-- -----------------------------------------------------------------------------
create table if not exists public.expert_ppts (
  id bigserial primary key,
  section_key text not null,
  title text not null,
  speaker text,
  hospital text,
  summary text,
  tags text,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Add any missing columns if the table existed from older versions
alter table public.expert_ppts add column if not exists section_key text;
alter table public.expert_ppts add column if not exists title text;
alter table public.expert_ppts add column if not exists speaker text;
alter table public.expert_ppts add column if not exists hospital text;
alter table public.expert_ppts add column if not exists summary text;
alter table public.expert_ppts add column if not exists tags text;
alter table public.expert_ppts add column if not exists author_id uuid;
alter table public.expert_ppts add column if not exists author_name text;
alter table public.expert_ppts add column if not exists created_at timestamptz;
alter table public.expert_ppts add column if not exists updated_at timestamptz;
alter table public.expert_ppts add column if not exists deleted_at timestamptz;

create index if not exists expert_ppts_section_key_idx on public.expert_ppts(section_key);
create index if not exists expert_ppts_created_at_idx on public.expert_ppts(created_at);

-- updated_at trigger (idempotent)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_expert_ppts_set_updated_at'
  ) then
    create trigger trg_expert_ppts_set_updated_at
    before update on public.expert_ppts
    for each row
    execute procedure public.set_updated_at();
  end if;
end $$;

alter table public.expert_ppts enable row level security;

-- Policies (drop + recreate)
drop policy if exists expert_ppts_select_public on public.expert_ppts;
create policy expert_ppts_select_public
on public.expert_ppts
for select
to anon, authenticated
using (deleted_at is null);

drop policy if exists expert_ppts_insert_verified on public.expert_ppts;
create policy expert_ppts_insert_verified
on public.expert_ppts
for insert
to authenticated
with check (
  auth.uid() = author_id
  and public.is_doctor_verified()
);

drop policy if exists expert_ppts_update_owner_or_admin on public.expert_ppts;
create policy expert_ppts_update_owner_or_admin
on public.expert_ppts
for update
to authenticated
using (
  auth.uid() = author_id
  or public.is_admin()
  or public.is_super_admin()
)
with check (
  auth.uid() = author_id
  or public.is_admin()
  or public.is_super_admin()
);

drop policy if exists expert_ppts_delete_owner_or_admin on public.expert_ppts;
create policy expert_ppts_delete_owner_or_admin
on public.expert_ppts
for delete
to authenticated
using (
  auth.uid() = author_id
  or public.is_admin()
  or public.is_super_admin()
);

-- -----------------------------------------------------------------------------
-- Attachments: expert_ppt uploads should also require doctor verification.
-- If you already have a stricter policy, feel free to keep it.
-- -----------------------------------------------------------------------------
drop policy if exists attachments_insert_own on public.attachments;
create policy attachments_insert_own
on public.attachments
for insert
to authenticated
with check (
  auth.uid() = author_id
  and (
    -- Attachments for these targets require doctor verification
    target_type not in ('case','case_comment','expert_ppt')
    or public.is_doctor_verified()
  )
);

-- -----------------------------------------------------------------------------
-- Supabase Storage: bucket + RLS policies for expert_ppt
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'expert_ppt',
  'expert_ppt',
  true,
  52428800,
  array[
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table storage.objects enable row level security;

-- Storage policies for expert_ppt bucket
-- IMPORTANT (Supabase):
-- In many Supabase projects, the table `storage.objects` is owned by `supabase_storage_admin`.
-- If you run CREATE/DROP POLICY from SQL Editor as `postgres`, you may hit:
--   ERROR: 42501: must be owner of table objects
-- So we DO NOT manage `storage.objects` policies here anymore.
--
-- Please configure the bucket and policies in Supabase Dashboard:
-- 1) Storage -> Buckets: create bucket `expert_ppt` (建议 Public, 50MB 或更大按需)
-- 2) Storage -> Policies (bucket expert_ppt)：
--    - INSERT (authenticated): bucket_id='expert_ppt' AND public.is_doctor_verified()
--    - UPDATE (authenticated): bucket_id='expert_ppt' AND ((owner=auth.uid()) OR public.is_admin() OR public.is_super_admin())
--    - DELETE (authenticated): bucket_id='expert_ppt' AND ((owner=auth.uid()) OR public.is_admin() OR public.is_super_admin())
--    - SELECT (可选):
--        a) bucket 设为 PUBLIC（则无需 SELECT policy 也能下载）
--        b) 或者给 authenticated：bucket_id='expert_ppt'
--
-- NOTE: 网站前端会把文件元数据写入 public.expert_ppts 表，因此 PPT 列表不依赖 storage.objects 的 SELECT。
--
commit;
