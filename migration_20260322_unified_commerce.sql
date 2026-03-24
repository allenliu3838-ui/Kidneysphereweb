-- ============================================================
-- Kidneysphere Unified Commerce System Migration
-- 统一商品中心 + 订单 + 权益 + 项目报名 + 学习群 + 审计日志
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- ============================================================

-- ============================================================
-- 1. PRODUCTS (统一商品中心)
-- ============================================================
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  product_type text not null check (product_type in (
    'membership_plan','specialty_bundle','single_video',
    'project_registration','registration_plus_bundle','combo_package'
  )),
  product_code text unique not null,
  title text not null,
  subtitle text,
  description text,
  cover_url text,
  price_cny numeric(10,2) not null default 0,
  list_price_cny numeric(10,2),
  duration_days integer default 365,
  specialty_id uuid,
  project_id uuid,
  cohort_id uuid,
  video_id uuid,
  recommended boolean not null default false,
  requires_review boolean not null default true,
  refund_policy_type text default 'no_refund',
  invoice_supported boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  -- for combo/bundle: list of included product ids
  includes_product_ids uuid[],
  -- membership sub-type
  membership_period text check (membership_period in ('monthly','yearly',null)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products enable row level security;

-- Product price versions (定价历史)
create table if not exists public.product_price_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  version_name text,
  list_price_cny numeric(10,2),
  sale_price_cny numeric(10,2) not null,
  effective_start_at timestamptz not null default now(),
  effective_end_at timestamptz,
  status text not null default 'active' check (status in ('active','expired','draft')),
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.product_price_versions enable row level security;

-- ============================================================
-- 2. SPECIALTIES (专科中心)
-- ============================================================
create table if not exists public.specialties (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  intro text,
  cover_url text,
  bundle_product_id uuid references public.products(id),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.specialties enable row level security;

-- ============================================================
-- 3. ORDERS (统一订单中心)
-- ============================================================
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  total_amount_cny numeric(10,2) not null default 0,
  status text not null default 'pending_payment' check (status in (
    'pending_payment','pending_review','approved','rejected','cancelled','refunded'
  )),
  channel text default 'wechat' check (channel in ('wechat','alipay','bank_transfer','online_wechat','online_alipay')),
  contact_wechat text,
  contact_phone text,
  contact_email text,
  remark text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  approved_at timestamptz,
  approved_by uuid,
  rejected_at timestamptz,
  rejected_by uuid,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  refunded_by uuid
);

alter table public.orders enable row level security;

-- Order items (订单项)
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_type text not null,
  product_title text not null,
  quantity integer not null default 1,
  unit_price_cny numeric(10,2) not null,
  amount_cny numeric(10,2) not null,
  created_at timestamptz not null default now()
);

alter table public.order_items enable row level security;

-- Payment proofs (支付凭证)
create table if not exists public.payment_proofs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text,
  payer_name text,
  paid_time timestamptz,
  transfer_ref_last4 text,
  amount_cny numeric(10,2),
  proof_image_url text,
  proof_bucket text,
  proof_path text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  review_result text check (review_result in ('approved','rejected',null)),
  review_note text
);

alter table public.payment_proofs enable row level security;

-- ============================================================
-- 4. ENTITLEMENTS (统一权益中心)
-- ============================================================
create table if not exists public.user_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entitlement_type text not null check (entitlement_type in (
    'membership','specialty_bundle','single_video',
    'project_access','cohort_access'
  )),
  source_order_id uuid references public.orders(id),
  source_product_id uuid references public.products(id),
  specialty_id uuid,
  video_id uuid,
  project_id uuid,
  cohort_id uuid,
  membership_product_id uuid,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  status text not null default 'active' check (status in ('active','expired','revoked')),
  granted_by uuid,
  grant_reason text,
  created_at timestamptz not null default now()
);

alter table public.user_entitlements enable row level security;

-- ============================================================
-- 5. PROJECTS & COHORTS (项目 + 班期)
-- ============================================================
create table if not exists public.learning_projects (
  id uuid primary key default gen_random_uuid(),
  project_code text unique not null,
  title text not null,
  intro text,
  cover_url text,
  registration_fee_cny numeric(10,2) default 0,
  requires_review boolean not null default true,
  includes_bundle_product_id uuid references public.products(id),
  includes_membership_product_id uuid references public.products(id),
  invoice_supported boolean not null default false,
  refund_policy_text text,
  is_active boolean not null default true,
  status text not null default 'draft' check (status in ('draft','recruiting','closed','ended')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.learning_projects enable row level security;

create table if not exists public.cohorts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.learning_projects(id) on delete cascade,
  cohort_code text unique not null,
  title text not null,
  start_date date,
  end_date date,
  registration_deadline timestamptz,
  quota integer,
  enrolled_count integer not null default 0,
  status text not null default 'draft' check (status in ('draft','recruiting','closed','ended')),
  group_required boolean not null default false,
  group_type text default 'wechat_group' check (group_type in ('wechat_group','wecom_group','other')),
  group_join_mode text default 'qr_code' check (group_join_mode in ('qr_code','manual_invite','operator_add')),
  group_qr_url text,
  group_qr_backup_url text,
  group_notice_template_id uuid,
  group_manager_name text,
  group_manager_contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cohorts enable row level security;

-- ============================================================
-- 6. PROJECT ENROLLMENTS (项目报名)
-- ============================================================
create table if not exists public.project_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.learning_projects(id) on delete cascade,
  cohort_id uuid references public.cohorts(id),
  source_order_id uuid references public.orders(id),
  enrollment_status text not null default 'pending' check (enrollment_status in (
    'pending','confirmed','cancelled','expired'
  )),
  approval_status text not null default 'pending' check (approval_status in (
    'pending','approved','rejected'
  )),
  approved_by uuid,
  approved_at timestamptz,
  joined_group_status text not null default 'not_required' check (joined_group_status in (
    'not_required','pending_review','eligible_for_group',
    'invite_pending','invite_sent','joined','left_group','expired'
  )),
  joined_group_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.project_enrollments enable row level security;

-- ============================================================
-- 7. STUDY GROUPS (学习群中心)
-- ============================================================
create table if not exists public.study_groups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.learning_projects(id),
  cohort_id uuid references public.cohorts(id),
  name text not null,
  group_type text default 'wechat_group' check (group_type in ('wechat_group','wecom_group','other')),
  join_mode text default 'qr_code' check (join_mode in ('qr_code','manual_invite','operator_add')),
  qr_url text,
  qr_backup_url text,
  manager_name text,
  manager_contact text,
  welcome_template_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.study_groups enable row level security;

create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  study_group_id uuid not null references public.study_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_enrollment_id uuid references public.project_enrollments(id),
  status text not null default 'pending' check (status in (
    'pending','sent','joined','expired','cancelled'
  )),
  sent_at timestamptz,
  joined_at timestamptz,
  confirmed_by uuid,
  note text,
  created_at timestamptz not null default now()
);

alter table public.group_invites enable row level security;

-- ============================================================
-- 8. NOTIFICATION TEMPLATES & JOBS (通知中心)
-- ============================================================
create table if not exists public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  type text not null default 'general',
  title text not null,
  subject text,
  body text not null,
  channel text not null default 'site' check (channel in ('site','email','sms')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notification_templates enable row level security;

create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.notification_templates(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  related_order_id uuid,
  related_project_id uuid,
  related_cohort_id uuid,
  related_group_id uuid,
  channel text not null default 'site',
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  payload_json jsonb,
  created_at timestamptz not null default now()
);

alter table public.notification_jobs enable row level security;

-- ============================================================
-- 9. AUDIT LOGS (审计日志)
-- ============================================================
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid,
  action text not null,
  target_type text,
  target_id text,
  before_json jsonb,
  after_json jsonb,
  ip text,
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

-- ============================================================
-- 10. SYSTEM CONFIG (系统配置中心)
-- ============================================================
create table if not exists public.system_config (
  key text primary key,
  value text,
  description text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table public.system_config enable row level security;

-- Insert default config values (idempotent)
insert into public.system_config (key, value, description) values
  ('membership_monthly_price', '0', '月费会员价格(元)'),
  ('membership_yearly_price', '0', '年费会员价格(元)'),
  ('membership_enabled', 'true', '是否开启会员购买'),
  ('specialty_bundle_default_price', '888', '专科整套课默认价格(元)'),
  ('single_video_default_price', '50', '单视频默认价格(元)'),
  ('bundle_auto_upgrade_enabled', 'true', '单视频累计满额自动升级整套课'),
  ('wechat_pay_qr_url', '', '微信收款码图片URL'),
  ('alipay_pay_qr_url', '', '支付宝收款码图片URL'),
  ('bank_name', '中国农业银行', '对公转账开户行'),
  ('bank_account', '09-410901040031935', '对公转账账号'),
  ('bank_account_name', '上海胥域医学科技有限公司', '对公转账户名'),
  ('company_name', '上海胥域医学科技有限公司', '公司主体名称'),
  ('contact_wechat', 'GlomConChina1', '联系微信号'),
  ('contact_email', 'china@kidneysphere.com', '联系邮箱'),
  ('payment_notice', '请在付款备注中填写您的订单号，以便管理员核对。', '支付页提示文案'),
  ('refund_policy', '课程类商品一经开通不支持退款，项目报名费退款规则以项目页面说明为准。', '退款政策')
on conflict (key) do nothing;

-- ============================================================
-- 11. STORAGE BUCKET for payment proofs
-- ============================================================
insert into storage.buckets (id, name, public)
values ('payment_proofs', 'payment_proofs', false)
on conflict (id) do nothing;

-- ============================================================
-- 12. RLS POLICIES
-- ============================================================

-- Drop existing policies first (idempotent)
do $$
declare pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'products','product_price_versions','specialties',
        'orders','order_items','payment_proofs',
        'user_entitlements','learning_projects','cohorts',
        'project_enrollments','study_groups','group_invites',
        'notification_templates','notification_jobs',
        'audit_logs','system_config'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

-- Products: everyone can read active products; admin can CRUD
create policy "products_read" on public.products for select using (true);
create policy "products_admin_insert" on public.products for insert with check (public.is_admin());
create policy "products_admin_update" on public.products for update using (public.is_admin());
create policy "products_admin_delete" on public.products for delete using (public.is_admin());

-- Product price versions: everyone reads; admin manages
create policy "ppv_read" on public.product_price_versions for select using (true);
create policy "ppv_admin_insert" on public.product_price_versions for insert with check (public.is_admin());
create policy "ppv_admin_update" on public.product_price_versions for update using (public.is_admin());

-- Specialties: everyone reads; admin manages
create policy "specialties_read" on public.specialties for select using (true);
create policy "specialties_admin_insert" on public.specialties for insert with check (public.is_admin());
create policy "specialties_admin_update" on public.specialties for update using (public.is_admin());

-- Orders: user reads own; admin reads all
create policy "orders_user_read" on public.orders for select using (auth.uid() = user_id or public.is_admin());
create policy "orders_user_insert" on public.orders for insert with check (auth.uid() = user_id);
create policy "orders_admin_update" on public.orders for update using (public.is_admin());

-- Order items: user reads own order items; admin reads all
create policy "oi_read" on public.order_items for select using (
  exists(select 1 from public.orders o where o.id = order_id and (o.user_id = auth.uid() or public.is_admin()))
);
create policy "oi_insert" on public.order_items for insert with check (
  exists(select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid())
);

-- Payment proofs: user manages own; admin reads all
create policy "pp_read" on public.payment_proofs for select using (user_id = auth.uid() or public.is_admin());
create policy "pp_user_insert" on public.payment_proofs for insert with check (user_id = auth.uid());
create policy "pp_admin_update" on public.payment_proofs for update using (public.is_admin());

-- Entitlements: user reads own; admin manages
create policy "ue_user_read" on public.user_entitlements for select using (user_id = auth.uid() or public.is_admin());
create policy "ue_admin_insert" on public.user_entitlements for insert with check (public.is_admin());
create policy "ue_admin_update" on public.user_entitlements for update using (public.is_admin());
create policy "ue_admin_delete" on public.user_entitlements for delete using (public.is_admin());

-- Learning projects: everyone reads active; admin manages
create policy "lp_read" on public.learning_projects for select using (true);
create policy "lp_admin_insert" on public.learning_projects for insert with check (public.is_admin());
create policy "lp_admin_update" on public.learning_projects for update using (public.is_admin());

-- Cohorts: everyone reads; admin manages
create policy "cohorts_read" on public.cohorts for select using (true);
create policy "cohorts_admin_insert" on public.cohorts for insert with check (public.is_admin());
create policy "cohorts_admin_update" on public.cohorts for update using (public.is_admin());

-- Project enrollments: user reads own; admin reads all & manages
create policy "pe_read" on public.project_enrollments for select using (user_id = auth.uid() or public.is_admin());
create policy "pe_user_insert" on public.project_enrollments for insert with check (user_id = auth.uid());
create policy "pe_admin_update" on public.project_enrollments for update using (public.is_admin());

-- Study groups: everyone reads active; admin manages
create policy "sg_read" on public.study_groups for select using (true);
create policy "sg_admin_insert" on public.study_groups for insert with check (public.is_admin());
create policy "sg_admin_update" on public.study_groups for update using (public.is_admin());

-- Group invites: user reads own; admin manages
create policy "gi_read" on public.group_invites for select using (user_id = auth.uid() or public.is_admin());
create policy "gi_admin_insert" on public.group_invites for insert with check (public.is_admin());
create policy "gi_admin_update" on public.group_invites for update using (public.is_admin());

-- Notification templates: everyone reads; admin manages
create policy "nt_read" on public.notification_templates for select using (true);
create policy "nt_admin_insert" on public.notification_templates for insert with check (public.is_admin());
create policy "nt_admin_update" on public.notification_templates for update using (public.is_admin());

-- Notification jobs: user reads own; admin manages
create policy "nj_read" on public.notification_jobs for select using (user_id = auth.uid() or public.is_admin());
create policy "nj_admin_insert" on public.notification_jobs for insert with check (public.is_admin());
create policy "nj_admin_update" on public.notification_jobs for update using (public.is_admin());

-- Audit logs: admin only
create policy "al_admin_read" on public.audit_logs for select using (public.is_admin());
create policy "al_admin_insert" on public.audit_logs for insert with check (public.is_admin());

-- System config: everyone reads; admin writes
create policy "sc_read" on public.system_config for select using (true);
create policy "sc_admin_update" on public.system_config for update using (public.is_admin());
create policy "sc_admin_insert" on public.system_config for insert with check (public.is_admin());

-- Payment proofs storage policies
do $$
begin
  -- Users can upload their own proofs
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'payment_proofs_user_upload') then
    create policy "payment_proofs_user_upload" on storage.objects for insert
      with check (bucket_id = 'payment_proofs' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  -- Users can read their own proofs
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'payment_proofs_user_read') then
    create policy "payment_proofs_user_read" on storage.objects for select
      using (bucket_id = 'payment_proofs' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
  end if;
end $$;

-- ============================================================
-- 13. HELPER FUNCTIONS (RPC)
-- ============================================================

-- Generate unique order number
create or replace function public.generate_order_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _no text;
  _exists boolean;
begin
  loop
    _no := 'KS' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD') ||
            lpad(floor(random() * 100000)::text, 5, '0');
    select exists(select 1 from public.orders where order_no = _no) into _exists;
    exit when not _exists;
  end loop;
  return _no;
end;
$$;

-- Admin approve order + auto-grant entitlements
create or replace function public.admin_approve_order(
  p_order_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _order record;
  _item record;
  _product record;
  _admin_id uuid := auth.uid();
  _result jsonb := '{"ok":true}'::jsonb;
begin
  -- Check admin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  -- Get order
  select * into _order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;
  if _order.status not in ('pending_review','pending_payment') then
    raise exception 'Order status is %, cannot approve', _order.status;
  end if;

  -- Update order
  update public.orders set
    status = 'approved',
    approved_at = now(),
    approved_by = _admin_id,
    remark = coalesce(p_note, remark)
  where id = p_order_id;

  -- Grant entitlements for each order item
  for _item in select * from public.order_items where order_id = p_order_id loop
    select * into _product from public.products where id = _item.product_id;
    if not found then continue; end if;

    -- Determine entitlement type
    if _product.product_type = 'membership_plan' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        membership_product_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'membership', p_order_id, _product.id,
        _product.id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');

      -- Also update profile membership_status
      update public.profiles set membership_status = 'member' where id = _order.user_id;

    elsif _product.product_type = 'specialty_bundle' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        specialty_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'specialty_bundle', p_order_id, _product.id,
        _product.specialty_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');

    elsif _product.product_type = 'single_video' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        video_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'single_video', p_order_id, _product.id,
        _product.video_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');

      -- Check auto-upgrade: if user spent >= bundle price on same specialty
      perform public.check_video_auto_upgrade(_order.user_id, _product.specialty_id);

    elsif _product.product_type = 'project_registration' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        project_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'project_access', p_order_id, _product.id,
        _product.project_id, now(), now() + coalesce((_product.duration_days || ' days')::interval, interval '365 days'),
        'active', _admin_id, 'order_approved');

      -- Auto-create enrollment if project_id set
      if _product.project_id is not null then
        insert into public.project_enrollments (user_id, project_id, cohort_id, source_order_id,
          enrollment_status, approval_status, approved_by, approved_at)
        values (_order.user_id, _product.project_id, _product.cohort_id, p_order_id,
          'confirmed', 'approved', _admin_id, now())
        on conflict do nothing;
      end if;

    elsif _product.product_type = 'registration_plus_bundle' then
      -- Grant both project access and specialty bundle
      if _product.project_id is not null then
        insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
          project_id, start_at, end_at, status, granted_by, grant_reason)
        values (_order.user_id, 'project_access', p_order_id, _product.id,
          _product.project_id, now(), now() + coalesce((_product.duration_days || ' days')::interval, interval '365 days'),
          'active', _admin_id, 'order_approved');

        insert into public.project_enrollments (user_id, project_id, cohort_id, source_order_id,
          enrollment_status, approval_status, approved_by, approved_at)
        values (_order.user_id, _product.project_id, _product.cohort_id, p_order_id,
          'confirmed', 'approved', _admin_id, now())
        on conflict do nothing;
      end if;

      if _product.specialty_id is not null then
        insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
          specialty_id, start_at, end_at, status, granted_by, grant_reason)
        values (_order.user_id, 'specialty_bundle', p_order_id, _product.id,
          _product.specialty_id, now(), now() + (_product.duration_days || ' days')::interval,
          'active', _admin_id, 'order_approved');
      end if;
    end if;
  end loop;

  -- Write audit log
  insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
  values (_admin_id, 'order_approved', 'order', p_order_id::text,
    jsonb_build_object('order_no', _order.order_no, 'user_id', _order.user_id, 'amount', _order.total_amount_cny, 'note', p_note));

  return _result;
end;
$$;

-- Admin reject order
create or replace function public.admin_reject_order(
  p_order_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _order record;
  _admin_id uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  select * into _order from public.orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;

  update public.orders set
    status = 'rejected',
    rejected_at = now(),
    rejected_by = _admin_id,
    remark = coalesce(p_note, remark)
  where id = p_order_id;

  insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
  values (_admin_id, 'order_rejected', 'order', p_order_id::text,
    jsonb_build_object('order_no', _order.order_no, 'note', p_note));

  return '{"ok":true}'::jsonb;
end;
$$;

-- Check single video auto-upgrade to bundle
create or replace function public.check_video_auto_upgrade(
  p_user_id uuid,
  p_specialty_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _total numeric;
  _bundle_price numeric;
  _enabled text;
  _has_bundle boolean;
begin
  if p_specialty_id is null then return; end if;

  -- Check if auto-upgrade is enabled
  select value into _enabled from public.system_config where key = 'bundle_auto_upgrade_enabled';
  if coalesce(_enabled, 'false') <> 'true' then return; end if;

  -- Check if user already has bundle for this specialty
  select exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'specialty_bundle'
      and specialty_id = p_specialty_id and status = 'active'
      and (end_at is null or end_at > now())
  ) into _has_bundle;
  if _has_bundle then return; end if;

  -- Get bundle price for this specialty
  select p.price_cny into _bundle_price
  from public.products p
  join public.specialties s on s.bundle_product_id = p.id
  where s.id = p_specialty_id and p.is_active = true;

  if _bundle_price is null or _bundle_price <= 0 then return; end if;

  -- Sum user's paid single video amounts for this specialty
  select coalesce(sum(oi.amount_cny), 0) into _total
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.products p on p.id = oi.product_id
  where o.user_id = p_user_id
    and o.status = 'approved'
    and p.product_type = 'single_video'
    and p.specialty_id = p_specialty_id;

  -- Auto-upgrade if total >= bundle price
  if _total >= _bundle_price then
    insert into public.user_entitlements (user_id, entitlement_type, specialty_id,
      start_at, end_at, status, grant_reason)
    values (p_user_id, 'specialty_bundle', p_specialty_id,
      now(), now() + interval '365 days', 'active', 'auto_upgrade_from_singles');

    insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
    values (p_user_id, 'auto_upgrade_bundle', 'user_entitlement', p_user_id::text,
      jsonb_build_object('specialty_id', p_specialty_id, 'total_spent', _total, 'bundle_price', _bundle_price));
  end if;
end;
$$;

-- Check user video access
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

  -- Check membership (for membership-level content only - not specialty courses)
  -- This returns false here because specialty content is not covered by membership
  return false;
end;
$$;

-- Get system config as JSON
create or replace function public.get_system_config()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_object_agg(key, value) from public.system_config;
$$;

-- Admin update system config
create or replace function public.admin_update_config(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  insert into public.system_config (key, value, updated_by, updated_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = p_value, updated_by = auth.uid(), updated_at = now();

  insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
  values (auth.uid(), 'config_updated', 'system_config', p_key,
    jsonb_build_object('key', p_key, 'value', p_value));
end;
$$;

-- Write audit log (callable from client for non-admin actions)
create or replace function public.write_audit_log(
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_after_json jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
  values (auth.uid(), p_action, p_target_type, p_target_id, p_after_json);
end;
$$;

-- ============================================================
-- 14. INDEXES
-- ============================================================
create index if not exists idx_products_type on public.products(product_type);
create index if not exists idx_products_active on public.products(is_active);
create index if not exists idx_products_specialty on public.products(specialty_id);
create index if not exists idx_orders_user on public.orders(user_id);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_orders_created on public.orders(created_at desc);
create index if not exists idx_order_items_order on public.order_items(order_id);
create index if not exists idx_entitlements_user on public.user_entitlements(user_id);
create index if not exists idx_entitlements_type on public.user_entitlements(entitlement_type);
create index if not exists idx_entitlements_status on public.user_entitlements(status);
create index if not exists idx_enrollments_user on public.project_enrollments(user_id);
create index if not exists idx_enrollments_project on public.project_enrollments(project_id);
create index if not exists idx_audit_logs_created on public.audit_logs(created_at desc);
create index if not exists idx_audit_logs_action on public.audit_logs(action);
create index if not exists idx_notification_jobs_user on public.notification_jobs(user_id);
create index if not exists idx_payment_proofs_order on public.payment_proofs(order_id);

-- ============================================================
-- Done. Reload Supabase API schema after running.
-- ============================================================
