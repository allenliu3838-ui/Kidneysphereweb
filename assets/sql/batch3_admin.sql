-- ============================================================
-- 0009_platform_admins.sql
-- 平台管理员体系
--
-- 新增内容：
--   1. platform_admins 表      — 记录平台管理员邮箱
--   2. partner 订阅计划        — 合作机构/友好单位，由管理员手动授权
--   3. is_platform_admin()     — 判断当前登录用户是否为平台管理员
--   4. admin_list_projects()   — 按邮箱搜索某用户的全部项目
--   5. admin_adjust_trial()    — 延长试用天数
--   6. admin_set_partner()     — 设为合作伙伴（长期免费）
--   7. admin_reset_to_trial()  — 撤回为普通试用
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. platform_admins 表
-- ──────────────────────────────────────────────────────────
create table if not exists public.platform_admins (
  email       text        not null primary key,
  note        text,
  created_at  timestamptz not null default now()
);

-- 仅 postgres / service_role 可直接操作该表；前端用户通过 RPC 间接访问
alter table public.platform_admins enable row level security;
-- 不授予 authenticated / anon 任何直接访问权限（RPC 走 SECURITY DEFINER）

-- ──────────────────────────────────────────────────────────
-- 2. 把 'partner' 加入 subscription_plan 允许值
--    旧约束：('trial', 'pro', 'institution')
--    新约束：('trial', 'pro', 'institution', 'partner')
-- ──────────────────────────────────────────────────────────
alter table public.projects
  drop constraint if exists subscription_plan_check;

alter table public.projects
  add constraint subscription_plan_check
  check (subscription_plan in ('trial', 'pro', 'institution', 'partner'));

-- ──────────────────────────────────────────────────────────
-- 3. 更新 assert_project_write_allowed：
--    partner 计划视同 pro/institution，按 active_until 判断
-- ──────────────────────────────────────────────────────────
create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trial_enabled  boolean;
  v_trial_expires  timestamptz;
  v_plan           text;
  v_sub_until      timestamptz;
begin
  select trial_enabled, trial_expires_at, subscription_plan, subscription_active_until
  into   v_trial_enabled, v_trial_expires, v_plan, v_sub_until
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- Rule A: 管理员已关闭试用限制
  if not v_trial_enabled then
    return;
  end if;

  -- Rule B: 付费订阅或合作伙伴计划有效
  if v_plan in ('pro', 'institution', 'partner') and
     (v_sub_until is null or now() <= v_sub_until) then
    return;
  end if;

  -- Rule C: 在试用期内
  if v_trial_expires is not null and now() <= v_trial_expires then
    return;
  end if;

  -- 以上均不满足 → 拒绝写入
  raise exception 'subscription_required';
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 4. is_platform_admin() — 当前用户是否为平台管理员
-- ──────────────────────────────────────────────────────────
create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public, auth
stable
as $$
  select exists (
    select 1 from public.platform_admins pa
    join auth.users u on u.email = pa.email
    where u.id = auth.uid()
  );
$$;

grant execute on function public.is_platform_admin() to authenticated;

-- ──────────────────────────────────────────────────────────
-- 5. admin_list_projects(p_email)
--    按邮箱搜索该用户名下所有项目（模糊匹配，ILIKE）
-- ──────────────────────────────────────────────────────────
drop function if exists public.admin_list_projects(text);
create or replace function public.admin_list_projects(p_email text)
returns table (
  project_id             uuid,
  project_name           text,
  center_code            text,
  module                 text,
  owner_email            text,
  subscription_plan      text,
  subscription_active_until timestamptz,
  trial_expires_at       timestamptz,
  trial_grace_until      timestamptz,
  created_at             timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  return query
  select
    p.id,
    p.name,
    p.center_code,
    p.module,
    u.email::text,
    p.subscription_plan,
    p.subscription_active_until,
    p.trial_expires_at,
    p.trial_grace_until,
    p.created_at
  from public.projects p
  join auth.users u on u.id = p.created_by
  where u.email ilike '%' || p_email || '%'
  order by p.created_at desc;
end;
$$;

grant execute on function public.admin_list_projects(text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 6. admin_adjust_trial(p_project_id, p_extra_days)
--    从「现在」或「当前到期日」两者较大值起，延长 N 天
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_adjust_trial(
  p_project_id uuid,
  p_extra_days  int default 30
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select greatest(trial_expires_at, now())
  into   v_base
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  update public.projects
  set
    trial_expires_at  = v_base + make_interval(days => p_extra_days),
    trial_grace_until = v_base + make_interval(days => p_extra_days) + interval '7 days',
    subscription_plan = 'trial'        -- 确保计划还是 trial（不影响已付费计划）
  where id = p_project_id
    and subscription_plan = 'trial';   -- 只改 trial 状态的项目，不覆盖 pro/institution

  -- 如果是付费计划，改写 active_until
  update public.projects
  set
    subscription_active_until = greatest(subscription_active_until, now())
                                + make_interval(days => p_extra_days)
  where id = p_project_id
    and subscription_plan in ('pro', 'institution');
end;
$$;

grant execute on function public.admin_adjust_trial(uuid, int) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. admin_set_partner(p_project_id, p_active_until)
--    设为合作伙伴计划（默认永久：2099-12-31）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_set_partner(
  p_project_id  uuid,
  p_active_until timestamptz default '2099-12-31 23:59:59+00'::timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.projects
  set
    subscription_plan         = 'partner',
    subscription_active_until = p_active_until
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;
end;
$$;

grant execute on function public.admin_set_partner(uuid, timestamptz) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 8. admin_reset_to_trial(p_project_id)
--    撤回为普通试用（从今天起 30 天 + 7 天宽限）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_reset_to_trial(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.projects
  set
    subscription_plan         = 'trial',
    subscription_active_until = null,
    trial_expires_at          = now() + interval '30 days',
    trial_grace_until         = now() + interval '37 days'
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;
end;
$$;

grant execute on function public.admin_reset_to_trial(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 初始管理员：在此处插入平台管理员邮箱
-- （部署时在 Supabase SQL Editor 运行一次）
-- ──────────────────────────────────────────────────────────
-- insert into public.platform_admins (email, note)
-- values ('your-admin@example.com', '平台超级管理员')
-- on conflict (email) do nothing;
-- ============================================================
-- 0010_user_profiles.sql
-- 用户资料表 + 管理员搜索结果带完整信息
--
-- 新增：
--   1. user_profiles 表         — 研究者姓名/医院/科室/意向/联系方式
--   2. upsert_my_profile()      — 用户自己保存/更新资料（RPC 供前端调用）
--   3. 更新 admin_list_projects  — 搜索结果附带所有资料字段
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. user_profiles 表
-- ──────────────────────────────────────────────────────────
create table if not exists public.user_profiles (
  user_id         uuid        not null primary key
                              references auth.users(id) on delete cascade,
  real_name       text,                        -- 姓名
  hospital        text,                        -- 医院/单位
  department      text,                        -- 科室
  interested_plan text,                        -- 意向套餐（仅参考，实际权益由管理员设置）
  contact         text,                        -- 联系方式（微信/手机，可选）
  notes           text,                        -- 备注
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

-- 用户只能读写自己的资料
DROP POLICY IF EXISTS "user_own_profile_select" ON user_profiles;
create policy "user_own_profile_select" on public.user_profiles
  for select using (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_profile_insert" ON user_profiles;
create policy "user_own_profile_insert" on public.user_profiles
  for insert with check (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_profile_update" ON user_profiles;
create policy "user_own_profile_update" on public.user_profiles
  for update using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 2. upsert_my_profile() — 用户自己保存资料
--    前端用 authenticated key 调用即可
-- ──────────────────────────────────────────────────────────
create or replace function public.upsert_my_profile(
  p_real_name       text default null,
  p_hospital        text default null,
  p_department      text default null,
  p_interested_plan text default null,
  p_contact         text default null,
  p_notes           text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles
    (user_id, real_name, hospital, department, interested_plan, contact, notes, updated_at)
  values
    (auth.uid(), p_real_name, p_hospital, p_department,
     p_interested_plan, p_contact, p_notes, now())
  on conflict (user_id) do update set
    real_name       = excluded.real_name,
    hospital        = excluded.hospital,
    department      = excluded.department,
    interested_plan = excluded.interested_plan,
    contact         = excluded.contact,
    notes           = excluded.notes,
    updated_at      = now();
end;
$$;

grant execute on function public.upsert_my_profile(text,text,text,text,text,text)
  to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. 更新 admin_list_projects — 附带 user_profiles 全部字段
--    （替换 0009 中的同名函数，需先 drop 旧签名）
-- ──────────────────────────────────────────────────────────
drop function if exists public.admin_list_projects(text);

create or replace function public.admin_list_projects(p_email text)
returns table (
  -- 项目字段
  project_id                uuid,
  project_name              text,
  center_code               text,
  module                    text,
  owner_email               text,
  subscription_plan         text,
  subscription_active_until timestamptz,
  trial_expires_at          timestamptz,
  trial_grace_until         timestamptz,
  project_created_at        timestamptz,
  -- 用户资料字段
  real_name                 text,
  hospital                  text,
  department                text,
  interested_plan           text,
  contact                   text,
  profile_notes             text,
  profile_updated_at        timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  return query
  select
    p.id,
    p.name,
    p.center_code,
    p.module,
    u.email::text,
    p.subscription_plan,
    p.subscription_active_until,
    p.trial_expires_at,
    p.trial_grace_until,
    p.created_at,
    -- user_profiles（未填写时全部为 NULL）
    pr.real_name,
    pr.hospital,
    pr.department,
    pr.interested_plan,
    pr.contact,
    pr.notes,
    pr.updated_at
  from public.projects p
  join auth.users u on u.id = p.created_by
  left join public.user_profiles pr on pr.user_id = p.created_by
  where u.email ilike '%' || p_email || '%'
  order by p.created_at desc;
end;
$$;

grant execute on function public.admin_list_projects(text) to authenticated;
-- ============================================================
-- 0011_partner_contracts.sql
-- 合作伙伴申请 & 合同管理
--
-- 流程：
--   用户提交申请 → 管理员审批（录价格/折扣）→ 收款后激活 → 自动开通权益
--
-- 新增：
--   1. partner_contracts 表
--   2. apply_partner_contract()   — 用户提交申请
--   3. get_my_contract()          — 用户查看自己的最新合同
--   4. admin_list_contracts()     — 管理员查看所有合同（带用户资料）
--   5. admin_review_contract()    — 管理员审批（录价格/折扣/备注）
--   6. admin_reject_contract()    — 管理员拒绝
--   7. admin_activate_contract()  — 确认收款并激活权益（更新所有该用户项目）
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. partner_contracts 表
-- ──────────────────────────────────────────────────────────
create table if not exists public.partner_contracts (
  id               uuid        not null primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,

  -- 用户申请时填写
  apply_plan       text        not null default 'institution'
                               check (apply_plan in ('pro','institution')),
  apply_note       text,                              -- 申请说明（研究方向、中心数等）
  applied_at       timestamptz not null default now(),

  -- 管理员审批字段
  status           text        not null default 'pending'
                               check (status in ('pending','approved','rejected','cancelled')),
  discount_pct     int         check (discount_pct between 1 and 99),  -- 40 = 6折（优惠40%）
  plan             text        check (plan in ('pro','institution','partner')),
  annual_price_cny numeric(10,2),                    -- 协议年费（元）
  payment_status   text        not null default 'unpaid'
                               check (payment_status in ('unpaid','paid','overdue')),
  paid_at          timestamptz,
  activated_at     timestamptz,
  expires_at       timestamptz,
  admin_note       text,                             -- 管理员备注

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.partner_contracts enable row level security;

-- 用户只能读自己的合同
DROP POLICY IF EXISTS "user_own_contracts_select" ON partner_contracts;
create policy "user_own_contracts_select" on public.partner_contracts
  for select using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 2. apply_partner_contract() — 用户提交申请
--    每个用户只能有一条 pending/approved 合同
-- ──────────────────────────────────────────────────────────
create or replace function public.apply_partner_contract(
  p_plan text default 'institution',
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- 检查是否已有进行中的申请
  if exists (
    select 1 from public.partner_contracts
    where user_id = auth.uid()
      and status in ('pending', 'approved')
  ) then
    raise exception 'contract_already_active: 已有进行中的申请或合同，如需变更请联系平台';
  end if;

  if p_plan not in ('pro', 'institution') then
    raise exception 'invalid_plan';
  end if;

  insert into public.partner_contracts (user_id, apply_plan, apply_note)
  values (auth.uid(), p_plan, p_note)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.apply_partner_contract(text, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. get_my_contract() — 用户查看自己最新合同状态
-- ──────────────────────────────────────────────────────────
drop function if exists public.get_my_contract();
create or replace function public.get_my_contract()
returns table (
  id               uuid,
  apply_plan       text,
  apply_note       text,
  applied_at       timestamptz,
  status           text,
  discount_pct     int,
  plan             text,
  annual_price_cny numeric,
  payment_status   text,
  paid_at          timestamptz,
  activated_at     timestamptz,
  expires_at       timestamptz,
  admin_note       text
)
language sql
security definer
set search_path = public
stable
as $$
  select id, apply_plan, apply_note, applied_at,
         status, discount_pct, plan, annual_price_cny,
         payment_status, paid_at, activated_at, expires_at, admin_note
  from public.partner_contracts
  where user_id = auth.uid()
  order by created_at desc
  limit 1;
$$;

grant execute on function public.get_my_contract() to authenticated;

-- ──────────────────────────────────────────────────────────
-- 4. admin_list_contracts() — 管理员查看所有合同
--    可按 status 过滤（null = 全部）
-- ──────────────────────────────────────────────────────────
drop function if exists public.admin_list_contracts(text);
create or replace function public.admin_list_contracts(
  p_status text default null   -- 'pending' / 'approved' / null(全部)
)
returns table (
  contract_id      uuid,
  user_id          uuid,
  owner_email      text,
  -- 用户资料
  real_name        text,
  hospital         text,
  department       text,
  contact          text,
  profile_notes    text,
  -- 申请信息
  apply_plan       text,
  apply_note       text,
  applied_at       timestamptz,
  -- 合同状态
  status           text,
  discount_pct     int,
  plan             text,
  annual_price_cny numeric,
  payment_status   text,
  paid_at          timestamptz,
  activated_at     timestamptz,
  expires_at       timestamptz,
  admin_note       text,
  created_at       timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  return query
  select
    c.id,
    c.user_id,
    u.email::text,
    pr.real_name,
    pr.hospital,
    pr.department,
    pr.contact,
    pr.notes,
    c.apply_plan,
    c.apply_note,
    c.applied_at,
    c.status,
    c.discount_pct,
    c.plan,
    c.annual_price_cny,
    c.payment_status,
    c.paid_at,
    c.activated_at,
    c.expires_at,
    c.admin_note,
    c.created_at
  from public.partner_contracts c
  join auth.users u on u.id = c.user_id
  left join public.user_profiles pr on pr.user_id = c.user_id
  where (p_status is null or c.status = p_status)
  order by
    case c.status when 'pending' then 0 when 'approved' then 1 else 2 end,
    c.applied_at desc;
end;
$$;

grant execute on function public.admin_list_contracts(text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 5. admin_review_contract() — 管理员审批（录价格/折扣）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_review_contract(
  p_contract_id    uuid,
  p_discount_pct   int          default null,   -- 如 40 = 优惠40% = 6折
  p_plan           text         default null,   -- 实际授予计划
  p_annual_price   numeric      default null,   -- 协议年费（元）
  p_admin_note     text         default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.partner_contracts
  set
    status           = 'approved',
    discount_pct     = coalesce(p_discount_pct, discount_pct),
    plan             = coalesce(p_plan,         apply_plan),
    annual_price_cny = coalesce(p_annual_price, annual_price_cny),
    admin_note       = coalesce(p_admin_note,   admin_note),
    updated_at       = now()
  where id = p_contract_id
    and status = 'pending';

  if not found then
    raise exception 'contract_not_found_or_not_pending';
  end if;
end;
$$;

grant execute on function public.admin_review_contract(uuid,int,text,numeric,text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 6. admin_reject_contract() — 管理员拒绝申请
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_reject_contract(
  p_contract_id uuid,
  p_admin_note  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.partner_contracts
  set status = 'rejected', admin_note = p_admin_note, updated_at = now()
  where id = p_contract_id and status = 'pending';

  if not found then
    raise exception 'contract_not_found_or_not_pending';
  end if;
end;
$$;

grant execute on function public.admin_reject_contract(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. admin_activate_contract() — 确认收款并激活
--    同时更新该用户名下所有项目的订阅
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_activate_contract(
  p_contract_id uuid,
  p_expires_at  timestamptz default null   -- 默认一年后
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_plan     text;
  v_expires  timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select user_id, coalesce(plan, apply_plan), coalesce(p_expires_at, now() + interval '1 year')
  into   v_user_id, v_plan, v_expires
  from   public.partner_contracts
  where  id = p_contract_id
    and  status = 'approved';

  if not found then
    raise exception 'contract_not_found_or_not_approved';
  end if;

  -- 更新合同
  update public.partner_contracts
  set
    payment_status = 'paid',
    paid_at        = now(),
    activated_at   = now(),
    expires_at     = v_expires,
    updated_at     = now()
  where id = p_contract_id;

  -- 该用户名下所有项目升级
  update public.projects
  set
    subscription_plan         = v_plan,
    subscription_active_until = v_expires
  where created_by = v_user_id;
end;
$$;

grant execute on function public.admin_activate_contract(uuid, timestamptz) to authenticated;
