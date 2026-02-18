-- KidneySphereAI / KidneySphere
-- Enable verified doctors to upload Expert PPT (PDF/Images)
-- and allow owners to soft-delete their own uploads.
--
-- Run in Supabase SQL Editor (Role: postgres), then:
--   Settings -> API -> Reload schema
--
-- Safe to re-run.

begin;

-- Defensive: some earlier deployments created doctor_verifications with fewer columns.
-- We keep this migration idempotent so you can safely re-run.
alter table if exists public.doctor_verifications
  add column if not exists status text default 'pending';
alter table if exists public.doctor_verifications
  add column if not exists method text default 'invite_code';
alter table if exists public.doctor_verifications
  add column if not exists reviewed_at timestamptz;

-- 1) Robust doctor verification check: profile role OR approved verification record.
create or replace function public.is_doctor_verified()
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select
    -- Roles that imply verified doctor access
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) in (
          'owner',
          'super_admin',
          'admin',
          'moderator',
          'doctor_verified',
          'doctor'
        )
    )
    -- Fallback: approved record in doctor_verifications
    or exists (
      select 1
      from public.doctor_verifications dv
      where dv.user_id = auth.uid()
        and lower(coalesce(dv.status, '')) = 'approved'
    );
$$;

grant execute on function public.is_doctor_verified() to anon, authenticated;

-- 2) expert_ppts: verified doctors can insert; owner/admin can update (soft-delete via update).
-- Drop old (admin-only) policies if present.
drop policy if exists expert_ppts_insert_admin on public.expert_ppts;
drop policy if exists expert_ppts_update_admin on public.expert_ppts;
drop policy if exists expert_ppts_delete_admin on public.expert_ppts;

-- Insert: must be verified, and author_id must be current user.
drop policy if exists expert_ppts_insert_verified on public.expert_ppts;
create policy expert_ppts_insert_verified
on public.expert_ppts
for insert
to authenticated
with check (
  public.is_doctor_verified()
  and auth.uid() = author_id
);

-- Update: owner of the row or admin.
drop policy if exists expert_ppts_update_owner_or_admin on public.expert_ppts;
create policy expert_ppts_update_owner_or_admin
on public.expert_ppts
for update
to authenticated
using (
  public.is_admin() or auth.uid() = author_id
)
with check (
  public.is_admin() or auth.uid() = author_id
);

-- 3) attachments insert: for case/case_comment/expert_ppt require verified doctor.
-- Replace the insert policy (it was tightened in previous migrations).
drop policy if exists attachments_insert_own on public.attachments;
create policy attachments_insert_own
on public.attachments
for insert
to authenticated
with check (
  auth.uid() = author_id
  and (
    target_type not in ('case', 'case_comment', 'expert_ppt')
    or public.is_doctor_verified()
  )
);

commit;
