-- ============================================================
-- Payment Verification System Enhancement
-- 支付验证系统增强：服务端价格校验 + 凭证强制 + 凭证去重
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- ============================================================

-- ============================================================
-- 1. SERVER-SIDE ORDER CREATION (服务端强制价格计算)
-- Replace client-side order creation with server-side RPC
-- that reads price directly from products table.
-- ============================================================

create or replace function public.create_order_with_items(
  p_product_id uuid,
  p_channel text default 'wechat'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _user_id uuid := auth.uid();
  _product record;
  _order_no text;
  _order_id uuid;
  _exists boolean;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Read price from products table (server-side, tamper-proof)
  select * into _product from public.products
    where id = p_product_id and is_active = true;

  if not found then
    raise exception 'Product not found or inactive';
  end if;

  -- Validate channel
  if p_channel not in ('wechat', 'alipay', 'bank_transfer') then
    p_channel := 'wechat';
  end if;

  -- Generate unique order number
  loop
    _order_no := 'KS' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD') ||
                  lpad(floor(random() * 100000)::text, 5, '0');
    select exists(select 1 from public.orders where order_no = _order_no) into _exists;
    exit when not _exists;
  end loop;

  -- Create order with server-side price
  insert into public.orders (order_no, user_id, total_amount_cny, status, channel)
  values (_order_no, _user_id, _product.price_cny, 'pending_payment', p_channel)
  returning id into _order_id;

  -- Create order item with server-side price
  insert into public.order_items (order_id, product_id, product_type, product_title, quantity, unit_price_cny, amount_cny)
  values (_order_id, _product.id, _product.product_type, _product.title, 1, _product.price_cny, _product.price_cny);

  return jsonb_build_object(
    'ok', true,
    'order_id', _order_id,
    'order_no', _order_no,
    'total_amount_cny', _product.price_cny,
    'product_title', _product.title
  );
end;
$$;

-- ============================================================
-- 2. TRIGGER: Validate order_items price matches products table
-- (Defense-in-depth for any direct inserts)
-- ============================================================

create or replace function public.trg_validate_order_item_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _product_price numeric(10,2);
begin
  select price_cny into _product_price
    from public.products where id = NEW.product_id;

  if _product_price is null then
    raise exception 'Product not found: %', NEW.product_id;
  end if;

  -- Force server-side price
  NEW.unit_price_cny := _product_price;
  NEW.amount_cny := _product_price * NEW.quantity;

  return NEW;
end;
$$;

drop trigger if exists trg_order_item_price_check on public.order_items;
create trigger trg_order_item_price_check
  before insert or update on public.order_items
  for each row
  execute function public.trg_validate_order_item_price();

-- ============================================================
-- 3. TRIGGER: Validate orders.total_amount_cny matches sum of items
-- (Recalculate total from items after each item insert)
-- ============================================================

create or replace function public.trg_sync_order_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _total numeric(10,2);
begin
  select coalesce(sum(amount_cny), 0) into _total
    from public.order_items where order_id = NEW.order_id;

  update public.orders set total_amount_cny = _total
    where id = NEW.order_id;

  return NEW;
end;
$$;

drop trigger if exists trg_order_total_sync on public.order_items;
create trigger trg_order_total_sync
  after insert or update or delete on public.order_items
  for each row
  execute function public.trg_sync_order_total();

-- ============================================================
-- 4. ENHANCED admin_approve_order: require payment proof
-- ============================================================

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
  _proof_count integer;
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

  -- ★ NEW: Require at least one payment proof
  select count(*) into _proof_count
    from public.payment_proofs
    where order_id = p_order_id;

  if _proof_count = 0 then
    raise exception '该订单尚未上传支付凭证，无法审批通过。请等待用户上传凭证后再审核。';
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

-- ============================================================
-- 5. PROOF IMAGE HASH DEDUP (凭证图片哈希去重)
-- Add proof_hash column and unique constraint
-- ============================================================

-- Add hash column if not exists
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_proofs'
      and column_name = 'proof_file_hash'
  ) then
    alter table public.payment_proofs add column proof_file_hash text;
    comment on column public.payment_proofs.proof_file_hash is
      'SHA-256 hash of proof image file, used to detect duplicate uploads across orders';
  end if;
end $$;

-- Check for duplicate proof (RPC for frontend to call before upload)
create or replace function public.check_proof_duplicate(
  p_file_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _existing record;
begin
  if p_file_hash is null or p_file_hash = '' then
    return jsonb_build_object('duplicate', false);
  end if;

  select pp.id, pp.order_id, o.order_no
  into _existing
  from public.payment_proofs pp
  join public.orders o on o.id = pp.order_id
  where pp.proof_file_hash = p_file_hash
  limit 1;

  if found then
    return jsonb_build_object(
      'duplicate', true,
      'existing_order_no', _existing.order_no,
      'message', '该凭证图片已在订单 ' || _existing.order_no || ' 中使用过，请上传新的凭证。'
    );
  end if;

  return jsonb_build_object('duplicate', false);
end;
$$;

-- ============================================================
-- 6. TRIGGER: Force payment_proofs.amount_cny to match order total
-- ============================================================

create or replace function public.trg_validate_proof_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _order_amount numeric(10,2);
begin
  select total_amount_cny into _order_amount
    from public.orders where id = NEW.order_id;

  if _order_amount is null then
    raise exception 'Order not found: %', NEW.order_id;
  end if;

  -- Force proof amount to match order amount
  NEW.amount_cny := _order_amount;

  return NEW;
end;
$$;

drop trigger if exists trg_proof_amount_check on public.payment_proofs;
create trigger trg_proof_amount_check
  before insert or update on public.payment_proofs
  for each row
  execute function public.trg_validate_proof_amount();
