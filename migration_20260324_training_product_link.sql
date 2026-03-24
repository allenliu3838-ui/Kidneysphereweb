-- ============================================================
-- Add product_code & price_cny to training_programs
-- Links training programs to unified commerce products table.
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
