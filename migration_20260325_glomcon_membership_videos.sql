-- ============================================================
-- Migration: GlomCon 中国会员视频系列
-- 1. 给 learning_videos 加 membership_accessible 字段
-- 2. 更新 check_video_access() 支持会员权益解锁
-- ============================================================

-- 1. Add membership_accessible column
alter table public.learning_videos
  add column if not exists membership_accessible boolean default false;

comment on column public.learning_videos.membership_accessible
  is '会员可看：true 表示付费会员可直接观看此视频（如 GlomCon 中国系列）';

-- 2. Update check_video_access to support membership entitlement
create or replace function public.check_video_access(
  p_user_id uuid,
  p_video_id uuid,
  p_specialty_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Check single video entitlement
  if exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'single_video'
      and video_id = p_video_id and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  -- Check specialty bundle entitlement
  if p_specialty_id is not null and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'specialty_bundle'
      and specialty_id = p_specialty_id and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  -- Check membership entitlement (for membership-accessible videos like GlomCon 中国)
  if exists(
    select 1 from public.learning_videos
    where id = p_video_id and membership_accessible = true
  ) and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'membership'
      and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  return false;
end;
$$;
