-- ============================================================
-- Fix: Prevent duplicate pending orders for same user + product
-- 修复：防止同一用户对同一产品创建重复的待付款订单
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
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

  -- Prevent duplicate: return existing pending order for same user + product
  select o.id, o.order_no into _order_id, _order_no
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
   where o.user_id = _user_id
     and oi.product_id = p_product_id
     and o.status = 'pending_payment'
   limit 1;

  if _order_id is not null then
    return jsonb_build_object(
      'ok', true,
      'order_id', _order_id,
      'order_no', _order_no,
      'total_amount_cny', _product.price_cny,
      'product_title', _product.title
    );
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
