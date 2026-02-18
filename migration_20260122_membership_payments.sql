-- MIGRATION_20260122_MEMBERSHIP_PAYMENTS.sql
-- Membership payments (WeChat/Alipay QR + upload proof + manual admin review)
-- Safe to run multiple times (idempotent where possible).

begin;

-- 1) Orders table
create table if not exists public.membership_orders (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,

  plan text not null default 'annual',
  amount_cny integer not null default 0,
  channel text not null default 'wechat', -- wechat | alipay
  status text not null default 'pending', -- pending | paid | rejected

  reference text, -- suggested remark code, e.g. KS-xxxx
  real_name text,
  hospital text,

  user_note text,
  admin_note text,

  proof_bucket text,
  proof_path text,
  proof_name text,

  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

create index if not exists membership_orders_user_created_idx
on public.membership_orders (user_id, created_at desc);

alter table public.membership_orders enable row level security;

-- 2) RLS policies (table)
drop policy if exists membership_orders_select_own_or_admin on public.membership_orders;
create policy membership_orders_select_own_or_admin
on public.membership_orders
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_admin()
);

drop policy if exists membership_orders_insert_own on public.membership_orders;
create policy membership_orders_insert_own
on public.membership_orders
for insert
to authenticated
with check (
  user_id = auth.uid()
  and status = 'pending'
);

drop policy if exists membership_orders_update_own_pending on public.membership_orders;
create policy membership_orders_update_own_pending
on public.membership_orders
for update
to authenticated
using (
  user_id = auth.uid()
  and status = 'pending'
)
with check (
  user_id = auth.uid()
);

drop policy if exists membership_orders_admin_update on public.membership_orders;
create policy membership_orders_admin_update
on public.membership_orders
for update
to authenticated
using ( public.is_admin() )
with check ( public.is_admin() );

drop policy if exists membership_orders_admin_delete on public.membership_orders;
create policy membership_orders_admin_delete
on public.membership_orders
for delete
to authenticated
using ( public.is_admin() );

-- 3) Storage bucket (private)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'membership_payment',
  'membership_payment',
  false,
  20971520,
  array['image/jpeg','image/png','image/webp','application/pdf']
)
on conflict (id) do nothing;

-- 4) Storage policies (objects)
-- Users can upload/update/delete under their own folder: {uid}/...
drop policy if exists "membership_payment_upload_own" on storage.objects;
create policy "membership_payment_upload_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'membership_payment'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "membership_payment_update_own" on storage.objects;
create policy "membership_payment_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'membership_payment'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'membership_payment'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "membership_payment_delete_own" on storage.objects;
create policy "membership_payment_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'membership_payment'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can read their own proofs; admins can read all.
drop policy if exists "membership_payment_read_own_or_admin" on storage.objects;
create policy "membership_payment_read_own_or_admin"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'membership_payment'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_admin()
  )
);

-- 5) Admin RPC: approve/reject an order and grant membership badge.
create or replace function public.admin_review_membership_order(
  target_order_id bigint,
  approve boolean,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_user uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select user_id into v_user
  from public.membership_orders
  where id = target_order_id
  for update;

  if v_user is null then
    raise exception 'order not found';
  end if;

  if approve then
    update public.membership_orders
    set status = 'paid',
        reviewed_at = now(),
        reviewed_by = auth.uid(),
        admin_note = note
    where id = target_order_id;

    -- Grant membership badge (simple: set membership_status = 'member')
    update public.profiles
    set membership_status = 'member'
    where id = v_user;

  else
    update public.membership_orders
    set status = 'rejected',
        reviewed_at = now(),
        reviewed_by = auth.uid(),
        admin_note = note
    where id = target_order_id;
  end if;
end;
$$;

grant execute on function public.admin_review_membership_order(bigint, boolean, text) to authenticated;

commit;

-- After running this migration, please go to:
-- Supabase Dashboard → Settings → API → Reload schema
