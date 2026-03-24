-- ============================================================
-- Add product_code & price_cny to training_programs
-- + RPC to look up product by code (avoids PostgREST schema cache uuid issues)
-- Idempotent (safe to re-run).
-- ============================================================

-- product_code: references products.product_code for checkout link
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'training_programs'
      and column_name = 'product_code'
  ) then
    alter table public.training_programs add column product_code text;
    comment on column public.training_programs.product_code is
      'Matches products.product_code — when set, a buy button links to checkout.html?product=<code>';
  end if;
end $$;

-- price_cny: display price on training cards (informational, actual price from products table)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'training_programs'
      and column_name = 'price_cny'
  ) then
    alter table public.training_programs add column price_cny numeric(10,2);
    comment on column public.training_programs.price_cny is
      'Display price on training card (informational). Actual charge from products.price_cny.';
  end if;
end $$;

-- RPC: look up active product by product_code or id
-- Returns single row as JSON, or null if not found.
-- This avoids PostgREST schema-cache issues with eq() on product_code.
create or replace function public.get_product_for_checkout(
  p_code text default null,
  p_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _row record;
begin
  if p_id is not null then
    select * into _row from public.products where id = p_id and is_active = true;
  elsif p_code is not null then
    select * into _row from public.products where product_code = p_code and is_active = true;
  else
    return null;
  end if;

  if not found then return null; end if;

  return jsonb_build_object(
    'id', _row.id,
    'product_type', _row.product_type,
    'product_code', _row.product_code,
    'title', _row.title,
    'subtitle', _row.subtitle,
    'description', _row.description,
    'cover_url', _row.cover_url,
    'price_cny', _row.price_cny,
    'list_price_cny', _row.list_price_cny,
    'duration_days', _row.duration_days,
    'specialty_id', _row.specialty_id,
    'project_id', _row.project_id,
    'cohort_id', _row.cohort_id,
    'video_id', _row.video_id,
    'recommended', _row.recommended,
    'requires_review', _row.requires_review,
    'refund_policy_type', _row.refund_policy_type,
    'invoice_supported', _row.invoice_supported,
    'is_active', _row.is_active,
    'sort_order', _row.sort_order,
    'includes_product_ids', _row.includes_product_ids,
    'membership_period', _row.membership_period
  );
end;
$$;

NOTIFY pgrst, 'reload schema';
