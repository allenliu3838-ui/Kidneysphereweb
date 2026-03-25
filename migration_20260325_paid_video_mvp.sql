-- ============================================================
-- Migration: Paid Video Access MVP
-- 付费视频观看闭环：权限字段 + 播放日志 + 权限校验增强
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- ============================================================

-- ============================================================
-- 1. learning_videos 补字段
-- ============================================================

-- access_type: 替代 is_paid + membership_accessible 的组合判断
-- registered_free  = 注册即可看（免费）
-- paid_single      = 单视频付费
-- paid_specialty   = 跟随专科课程（specialty_bundle / project_access 可看）
-- paid_membership  = 付费会员可看（如 GlomCon 中国）
alter table public.learning_videos
  add column if not exists access_type text default 'registered_free'
  check (access_type in ('registered_free','paid_single','paid_specialty','paid_membership'));

comment on column public.learning_videos.access_type
  is '视频访问类型：registered_free=注册可看, paid_single=单视频付费, paid_specialty=专科课程付费, paid_membership=会员可看';

-- price: 单视频价格（分）
alter table public.learning_videos
  add column if not exists price numeric(10,2) default 0;

comment on column public.learning_videos.price
  is '单视频售价（元），仅 paid_single 时有效';

-- cover_image: 视频封面
alter table public.learning_videos
  add column if not exists cover_image text;

-- description: 视频简介
alter table public.learning_videos
  add column if not exists description text;

-- is_published: 是否上架
alter table public.learning_videos
  add column if not exists is_published boolean default true;

comment on column public.learning_videos.is_published
  is '是否上架，false=草稿';

-- sort_order: 排序
alter table public.learning_videos
  add column if not exists sort_order integer default 0;

-- duration: 视频时长（秒）
alter table public.learning_videos
  add column if not exists duration integer;

-- Sync access_type from existing is_paid / membership_accessible flags
-- (Run once; afterward new videos should set access_type directly)
update public.learning_videos
  set access_type = 'paid_membership'
  where membership_accessible = true and (access_type is null or access_type = 'registered_free');

update public.learning_videos
  set access_type = 'paid_specialty'
  where is_paid = true and specialty_id is not null
    and membership_accessible is not true
    and (access_type is null or access_type = 'registered_free');

update public.learning_videos
  set access_type = 'paid_single'
  where is_paid = true and specialty_id is null
    and membership_accessible is not true
    and (access_type is null or access_type = 'registered_free');

-- Sync is_published from enabled
update public.learning_videos
  set is_published = enabled
  where is_published is null or is_published = true;

-- ============================================================
-- 2. play_logs 播放日志表
-- ============================================================
create table if not exists public.play_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  video_id uuid references public.learning_videos(id) on delete set null,
  status text not null default 'requested' check (status in ('requested','authorized','played','denied','error')),
  error_code text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.play_logs enable row level security;

-- Users can only see their own logs
drop policy if exists play_logs_user_read on public.play_logs;
create policy play_logs_user_read on public.play_logs
  for select using (user_id = auth.uid());

-- Insert allowed for authenticated users (their own logs)
drop policy if exists play_logs_user_insert on public.play_logs;
create policy play_logs_user_insert on public.play_logs
  for insert with check (user_id = auth.uid());

-- Admin can read all
drop policy if exists play_logs_admin_read on public.play_logs;
create policy play_logs_admin_read on public.play_logs
  for select using (public.is_admin());

-- Service role can do anything (for Netlify functions)
-- (handled by service_role key bypassing RLS)

-- Index for fast lookup
create index if not exists idx_play_logs_user_video on public.play_logs (user_id, video_id, created_at desc);
create index if not exists idx_play_logs_video on public.play_logs (video_id, created_at desc);

-- ============================================================
-- 3. Enhanced check_video_access() with project_access support
-- ============================================================
-- Training project users (project_access entitlement) should be able to:
-- 1. Watch all videos in their purchased specialty
-- 2. Watch membership-accessible videos (GlomCon 中国 etc.)
-- This makes project_access a superset of membership for video access.
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
declare
  v_access_type text;
  v_membership_accessible boolean;
  v_specialty_id uuid;
begin
  -- Fetch video metadata
  select access_type, membership_accessible, specialty_id
    into v_access_type, v_membership_accessible, v_specialty_id
    from public.learning_videos
    where id = p_video_id;

  -- If video not found, deny
  if v_access_type is null then return false; end if;

  -- registered_free: always allowed for authenticated users
  if v_access_type = 'registered_free' then return true; end if;

  -- Use p_specialty_id from param or from video record
  if p_specialty_id is null then
    p_specialty_id := v_specialty_id;
  end if;

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

  -- Check project_access entitlement (training project users)
  -- Project access covers: specialty videos + membership videos (GlomCon etc.)
  if p_specialty_id is not null and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'project_access'
      and specialty_id = p_specialty_id and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  -- Training project users can also see membership-accessible videos (GlomCon etc.)
  if (v_access_type = 'paid_membership' or v_membership_accessible = true) and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'project_access'
      and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  -- Check membership entitlement (for membership-accessible videos)
  if (v_access_type = 'paid_membership' or v_membership_accessible = true) and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'membership'
      and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  return false;
end;
$$;

-- ============================================================
-- 4. RPC: get_video_access_info (returns detailed access status)
-- Used by frontend to show appropriate UI (buy button, play button, etc.)
-- ============================================================
create or replace function public.get_video_access_info(p_video_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_row record;
  v_can_play boolean := false;
  v_need_login boolean := false;
  v_need_purchase boolean := false;
  v_reason text := '';
begin
  v_user_id := auth.uid();

  select id, title, access_type, price, cover_image, description,
         speaker, category, specialty_id, product_id, aliyun_vid,
         membership_accessible, is_published
    into v_row
    from public.learning_videos
    where id = p_video_id and deleted_at is null;

  if v_row.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;

  if v_row.is_published is not true then
    return jsonb_build_object('error', 'not_published');
  end if;

  -- Not logged in
  if v_user_id is null then
    v_need_login := true;
    if v_row.access_type = 'registered_free' then
      v_reason := 'login_required';
    else
      v_reason := 'login_then_purchase';
      v_need_purchase := true;
    end if;
  else
    -- Logged in
    if v_row.access_type = 'registered_free' then
      v_can_play := true;
      v_reason := 'free';
    else
      v_can_play := public.check_video_access(v_user_id, p_video_id, v_row.specialty_id);
      if v_can_play then
        v_reason := 'entitled';
      else
        v_need_purchase := true;
        v_reason := 'purchase_required';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'canPlay', v_can_play,
    'needLogin', v_need_login,
    'needPurchase', v_need_purchase,
    'reason', v_reason,
    'video', jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'accessType', v_row.access_type,
      'price', v_row.price,
      'coverImage', v_row.cover_image,
      'description', v_row.description,
      'speaker', v_row.speaker,
      'category', v_row.category,
      'specialtyId', v_row.specialty_id,
      'productId', v_row.product_id,
      'hasAliyunVod', (v_row.aliyun_vid is not null and v_row.aliyun_vid != ''),
      'membershipAccessible', v_row.membership_accessible
    )
  );
end;
$$;
