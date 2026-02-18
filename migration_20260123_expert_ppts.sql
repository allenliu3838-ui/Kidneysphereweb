-- Expert PPT module (table + RLS) + restrict attachments for expert_ppt uploads
-- Run in Supabase SQL Editor, then Reload schema.

begin;

-- 1) Expert PPT records
create table if not exists public.expert_ppts (
  id bigserial primary key,
  section_key text,
  title text not null,
  speaker text,
  hospital text,
  summary text,
  tags text,
  author_id uuid,
  author_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Touch updated_at
create or replace function public.trg_touch_expert_ppts_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists touch_expert_ppts_updated_at on public.expert_ppts;
create trigger touch_expert_ppts_updated_at
before update on public.expert_ppts
for each row execute function public.trg_touch_expert_ppts_updated_at();

-- RLS
alter table public.expert_ppts enable row level security;

-- Everyone can read (site-wide content)
drop policy if exists expert_ppts_select_all on public.expert_ppts;
create policy expert_ppts_select_all on public.expert_ppts
for select using (true);

-- Only admin/super_admin can manage
-- (public.is_admin() already exists in this project)
drop policy if exists expert_ppts_admin_write on public.expert_ppts;
create policy expert_ppts_admin_write on public.expert_ppts
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Helpful index for filtering
create index if not exists idx_expert_ppts_deleted_at on public.expert_ppts (deleted_at);
create index if not exists idx_expert_ppts_created_at on public.expert_ppts (created_at desc);

-- 2) Tighten attachments insert rule for expert_ppt uploads
-- Existing logic:
--   - case/case_comment require doctor verified
--   - other target types allowed (author_id==auth.uid)
-- We add:
--   - expert_ppt requires admin

drop policy if exists attachments_insert_own on public.attachments;
create policy attachments_insert_own
on public.attachments
for insert
to authenticated
with check (
  auth.uid() = author_id
  and (
    (target_type in ('case', 'case_comment') and public.is_doctor_verified())
    or (target_type = 'expert_ppt' and public.is_admin())
    or (target_type not in ('case', 'case_comment', 'expert_ppt'))
  )
);

commit;
