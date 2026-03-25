-- ============================================================
-- Instant Checkout: self-service order completion for digital products
-- Products with requires_review = false can be auto-completed by the buyer.
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- ============================================================

-- RPC: complete_instant_order
-- Called by the buyer after payment (QR scan). For products where
-- requires_review = false, this auto-approves the order and grants
-- entitlements — no admin review needed.
create or replace function public.complete_instant_order(
  p_order_id uuid
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
  _user_id uuid := auth.uid();
  _result jsonb := '{"ok":true}'::jsonb;
begin
  if _user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Get order (must belong to current user)
  select * into _order from public.orders where id = p_order_id and user_id = _user_id;
  if not found then
    raise exception 'Order not found or not yours';
  end if;
  if _order.status not in ('pending_payment','pending_review') then
    raise exception 'Order status is %, cannot complete', _order.status;
  end if;

  -- Verify ALL products in this order allow instant checkout
  for _item in select * from public.order_items where order_id = p_order_id loop
    select * into _product from public.products where id = _item.product_id;
    if not found then
      raise exception 'Product not found for item %', _item.id;
    end if;
    if _product.requires_review = true then
      raise exception 'Product "%" requires manual review. Please upload payment proof.', _product.title;
    end if;
  end loop;

  -- Update order to approved (self-service)
  update public.orders set
    status = 'approved',
    paid_at = coalesce(paid_at, now()),
    approved_at = now(),
    approved_by = _user_id,
    remark = coalesce(remark, '') || ' [instant-checkout]'
  where id = p_order_id;

  -- Grant entitlements for each order item (same logic as admin_approve_order)
  for _item in select * from public.order_items where order_id = p_order_id loop
    select * into _product from public.products where id = _item.product_id;
    if not found then continue; end if;

    if _product.product_type = 'membership_plan' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        membership_product_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'membership', p_order_id, _product.id,
        _product.id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _user_id, 'instant_checkout');
      update public.profiles set membership_status = 'member' where id = _order.user_id;

    elsif _product.product_type = 'specialty_bundle' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        specialty_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'specialty_bundle', p_order_id, _product.id,
        _product.specialty_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _user_id, 'instant_checkout');

    elsif _product.product_type = 'single_video' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        video_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'single_video', p_order_id, _product.id,
        _product.video_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _user_id, 'instant_checkout');
      perform public.check_video_auto_upgrade(_order.user_id, _product.specialty_id);

    elsif _product.product_type in ('project_registration','registration_plus_bundle') then
      -- These should have requires_review = true, but handle just in case
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        project_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'project_access', p_order_id, _product.id,
        _product.project_id, now(), now() + coalesce((_product.duration_days || ' days')::interval, interval '365 days'),
        'active', _user_id, 'instant_checkout');
    end if;
  end loop;

  return _result;
end;
$$;

NOTIFY pgrst, 'reload schema';
