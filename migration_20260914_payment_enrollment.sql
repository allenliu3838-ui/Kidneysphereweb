-- Payment fulfillment release 2026-09-14. Database-owner execution only.
-- Apply training-prices-20260914-v1 first (or use the combined atomic release).
-- No migration step scans or changes customer orders, proofs or entitlements.
-- Legacy repairs are explicit administrator actions; rollback retains their data.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('kidneysphere-payment-enrollment-20260914-v1', 0));

create schema if not exists kidneysphere_release_private;
revoke all on schema kidneysphere_release_private from public;
create table if not exists kidneysphere_release_private.payment_enrollment_releases (
  release_key text primary key, state text not null check (state in ('applied','rolled_back')),
  applied_at timestamptz not null default now(), rolled_back_at timestamptz
);
create table if not exists kidneysphere_release_private.payment_function_backups (
  release_key text not null, signature text not null, before_value jsonb, after_value jsonb,
  primary key(release_key, signature)
);
create table if not exists kidneysphere_release_private.payment_table_backups (
  release_key text not null, table_name text not null, before_value jsonb, after_value jsonb,
  primary key(release_key, table_name)
);
create table if not exists kidneysphere_release_private.payment_catalog_backups (
  product_id uuid primary key, baseline jsonb not null, before_binding jsonb not null, after_binding jsonb not null
);
create table if not exists kidneysphere_release_private.payment_product_manifest (
  product_code text primary key, product_type text not null, variant text not null,
  specialty_code text not null, project_code text not null, product_id uuid unique,
  specialty_id uuid, project_id uuid
);
create table if not exists kidneysphere_release_private.payment_item_snapshots (
  order_item_id uuid primary key references public.order_items(id), order_id uuid not null references public.orders(id),
  payload jsonb not null, mapping_source text not null, created_at timestamptz not null default now()
);
create table if not exists kidneysphere_release_private.payment_approval_receipts (
  order_id uuid primary key references public.orders(id), approved_by uuid not null,
  approved_at timestamptz not null, review_fingerprint text not null, receipt_confirmed boolean not null check(receipt_confirmed)
);

-- Exact catalog identity; titles and amounts are never classification inputs.
insert into kidneysphere_release_private.payment_product_manifest
  (product_code, product_type, variant, specialty_code, project_code)
values
 ('GLOM-BUNDLE-2026','specialty_bundle','bundle','glom','PROJ-GLOM-2026'),
 ('GLOM-REG-FULL-2026','project_registration','full','glom','PROJ-GLOM-2026'),
 ('GLOM-REG-VIDEO-2026','project_registration','video','glom','PROJ-GLOM-2026'),
 ('ICU-BUNDLE-2026','specialty_bundle','bundle','icu','PROJ-ICU-2026'),
 ('ICU-REG-FULL-2026','project_registration','full','icu','PROJ-ICU-2026'),
 ('ICU-REG-VIDEO-2026','project_registration','video','icu','PROJ-ICU-2026'),
 ('TX-BUNDLE-2026','specialty_bundle','bundle','tx','PROJ-TX-2026'),
 ('TX-REG-FULL-2026','project_registration','full','tx','PROJ-TX-2026'),
 ('TX-REG-VIDEO-2026','project_registration','video','tx','PROJ-TX-2026'),
 ('PATHO-BUNDLE-2026','specialty_bundle','bundle','patho','PROJ-PATHO-2026'),
 ('PATHO-REG-FULL-2026','project_registration','full','patho','PROJ-PATHO-2026'),
 ('PATHO-REG-VIDEO-2026','project_registration','video','patho','PROJ-PATHO-2026'),
 ('DA-BUNDLE-2026','specialty_bundle','bundle','da','PROJ-DA-2026'),
 ('DA-REG-FULL-2026','project_registration','full','da','PROJ-DA-2026'),
 ('DA-REG-VIDEO-2026','project_registration','video','da','PROJ-DA-2026')
on conflict(product_code) do nothing;

create or replace function kidneysphere_release_private.payment_function_state(p_signature text)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',(select coalesce(jsonb_agg(to_jsonb(a) order by a.grantee,a.privilege_type),'[]'::jsonb) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'owner',p.proowner)
 from pg_proc p where p.oid=to_regprocedure(p_signature);
$$;
create or replace function kidneysphere_release_private.payment_table_state(p_table text)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select jsonb_build_object('acl',(select coalesce(jsonb_agg(to_jsonb(x) order by x.grantee,x.privilege_type),'[]'::jsonb) from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x),'owner',c.relowner,'columns',
   (select jsonb_agg(jsonb_build_object('name',a.attname,'acl',(select coalesce(jsonb_agg(to_jsonb(x) order by x.grantee,x.privilege_type),'[]'::jsonb) from aclexplode(a.attacl) x)) order by a.attnum)
    from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped))
 from pg_class c where c.oid=to_regclass('public.'||quote_ident(p_table));
$$;

-- Verify an existing release BEFORE replacing any public code or permissions.
lock table public.products, public.specialties, public.learning_projects, public.cohorts in share row exclusive mode;
do $$ declare r record; st text; expected jsonb;
begin
 if to_regclass('kidneysphere_release_private.training_price_releases') is null then
   raise exception 'PAYMENT_RELEASE_BLOCKED: apply training pricing release first';
 end if;
 if not exists(select 1 from kidneysphere_release_private.training_price_releases
   where release_key='training-prices-20260914-v1' and state='applied') then
   raise exception 'PAYMENT_RELEASE_BLOCKED: pricing release is not applied';
 end if;
 select state into st from kidneysphere_release_private.payment_enrollment_releases where release_key='payment-enrollment-20260914-v1';
 if st is not null then
   for r in select * from kidneysphere_release_private.payment_function_backups loop
     expected:=case when st='applied' then r.after_value else r.before_value end;
     if kidneysphere_release_private.payment_function_state(r.signature) is distinct from expected then
       raise exception 'PAYMENT_RELEASE_CONFLICT: function % changed',r.signature;
     end if;
   end loop;
   for r in select * from kidneysphere_release_private.payment_table_backups loop
     expected:=case when st='applied' then r.after_value else r.before_value end;
     if kidneysphere_release_private.payment_table_state(r.table_name) is distinct from expected then
       raise exception 'PAYMENT_RELEASE_CONFLICT: permissions for % changed',r.table_name;
     end if;
   end loop;
   for r in select b.*,p.id as live_id,jsonb_build_object('project_id',p.project_id,'cohort_id',p.cohort_id) as actual
     from kidneysphere_release_private.payment_catalog_backups b left join public.products p on p.id=b.product_id loop
     if r.live_id is null or r.actual is distinct from (case when st='applied' then r.after_binding else r.before_binding end) then
       raise exception 'PAYMENT_RELEASE_CONFLICT: product binding % changed',r.product_id;
     end if;
   end loop;
 end if;
 -- Missing or altered identities block release; no fallback by title or price.
 if exists(select 1 from kidneysphere_release_private.payment_product_manifest m
   left join public.products p using(product_code)
   left join public.specialties s on s.code=m.specialty_code
   left join public.learning_projects lp on lp.project_code=m.project_code
   left join public.products b on b.id=lp.includes_bundle_product_id
   where p.id is null or s.id is null or lp.id is null
     or p.product_type is distinct from m.product_type or p.specialty_id is distinct from s.id
     or (m.product_id is not null and (p.id<>m.product_id or s.id<>m.specialty_id or lp.id<>m.project_id))
     or b.product_code is distinct from (upper(m.specialty_code)||'-BUNDLE-2026')
     or b.product_type is distinct from 'specialty_bundle' or b.specialty_id is distinct from s.id
     or (p.project_id is not null and (m.variant<>'full' or p.project_id<>lp.id))
     or (p.cohort_id is not null and (m.variant<>'full' or not exists(select 1 from public.cohorts c where c.id=p.cohort_id and c.project_id=lp.id)))
     or (m.variant='video' and p.is_active)) then
   raise exception 'PAYMENT_RELEASE_BLOCKED: exact SKU/type/specialty/project/bundle/cohort identity check failed, or VIDEO still on sale';
 end if;
 if exists(select 1 from public.products p where
   (p.product_type in ('specialty_bundle','project_registration','registration_plus_bundle') or p.project_id is not null or p.cohort_id is not null)
   and not exists(select 1 from kidneysphere_release_private.payment_product_manifest m where m.product_code=p.product_code)) then
   raise exception 'PAYMENT_RELEASE_BLOCKED: unmapped training SKU requires an explicit manifest';
 end if;
end $$;

update kidneysphere_release_private.payment_product_manifest m set
 product_id=p.id,specialty_id=s.id,project_id=lp.id
from public.products p,public.specialties s,public.learning_projects lp
where p.product_code=m.product_code and s.code=m.specialty_code and lp.project_code=m.project_code
 and m.product_id is null;
insert into kidneysphere_release_private.payment_catalog_backups(product_id,baseline,before_binding,after_binding)
select p.id,to_jsonb(p),jsonb_build_object('project_id',p.project_id,'cohort_id',p.cohort_id),
 jsonb_build_object('project_id',case when m.variant='full' then m.project_id else p.project_id end,'cohort_id',p.cohort_id)
from public.products p left join kidneysphere_release_private.payment_product_manifest m using(product_code)
where not exists(select 1 from kidneysphere_release_private.payment_enrollment_releases where release_key='payment-enrollment-20260914-v1')
on conflict(product_id) do nothing;
update public.products p set project_id=m.project_id,updated_at=now()
from kidneysphere_release_private.payment_product_manifest m
where p.id=m.product_id and m.variant='full' and p.project_id is distinct from m.project_id;

-- Capture function definitions AND ACL before installing replacements.
insert into kidneysphere_release_private.payment_function_backups(release_key,signature,before_value)
select 'payment-enrollment-20260914-v1',sig,kidneysphere_release_private.payment_function_state(sig)
from unnest(array[
 'public.create_order_with_items(uuid,text)',
 'public.submit_order_for_review(uuid,text,text,text)',
 'public.submit_payment_proof(uuid,text,numeric,text,text,text,text,text,text,text,text)',
 'public.trg_validate_proof_amount()',
 'public.admin_approve_order(uuid,text)',
 'public.admin_approve_order_verified(uuid,boolean,text,text)',
 'public.admin_get_order_fulfillment(uuid)',
 'public.admin_list_payment_enrollment_issues(integer,integer)',
 'public.admin_repair_order_enrollment(uuid,text)',
 'public.get_my_enrollments()',
 'public.get_my_learning_enrollments()',
 'public.admin_get_cohorts(uuid)',
 'public.admin_get_study_groups()',
 'public.get_payment_enrollment_release()'
]) sig on conflict do nothing;
insert into kidneysphere_release_private.payment_table_backups(release_key,table_name,before_value)
select 'payment-enrollment-20260914-v1',t,kidneysphere_release_private.payment_table_state(t)
from unnest(array['orders','order_items','payment_proofs','project_enrollments','cohorts','study_groups']) t on conflict do nothing;

-- Private resolver uses the purchase snapshot or release-time catalog baseline.
-- A new purchase uses the live row only while it is locked by create_order.
create or replace function kidneysphere_release_private.payment_resolve_product(p_data jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare m kidneysphere_release_private.payment_product_manifest%rowtype;
 typ text:=p_data->>'product_type'; variant text; project uuid; cohort uuid;
 specialty uuid:=(p_data->>'specialty_id')::uuid; duration integer:=(p_data->>'duration_days')::integer;
begin
 if p_data is null then raise exception 'FULFILLMENT_BLOCKED: product identity unavailable'; end if;
 select * into m from kidneysphere_release_private.payment_product_manifest where product_code=p_data->>'product_code';
 if found then
   if (p_data->>'id')::uuid is distinct from m.product_id or typ is distinct from m.product_type
     or specialty is distinct from m.specialty_id then
     raise exception 'FULFILLMENT_BLOCKED: SKU identity/type/specialty differs from approved manifest';
   end if;
   variant:=m.variant;
   if variant='full' then
     project:=m.project_id; cohort:=(p_data->>'cohort_id')::uuid;
     if (p_data->>'project_id')::uuid is not null and (p_data->>'project_id')::uuid<>project then
       raise exception 'FULFILLMENT_BLOCKED: FULL project conflicts with exact mapping';
     end if;
     if cohort is not null and not exists(select 1 from public.cohorts c where c.id=cohort and c.project_id=project) then
       raise exception 'FULFILLMENT_BLOCKED: cohort does not belong to mapped project';
     end if;
   elsif (p_data->>'project_id')::uuid is not null or (p_data->>'cohort_id')::uuid is not null then
     raise exception 'FULFILLMENT_BLOCKED: video-only product has training binding';
   end if;
 elsif typ='membership_plan' then variant:='membership';
 elsif typ='single_video' and (p_data->>'video_id')::uuid is not null then variant:='single_video';
 else raise exception 'FULFILLMENT_BLOCKED: unsupported or unmapped SKU';
 end if;
 duration:=coalesce(duration,365);
 if duration<=0 then raise exception 'FULFILLMENT_BLOCKED: invalid duration'; end if;
 return jsonb_build_object('product_id',p_data->'id','product_code',p_data->'product_code',
   'product_type',typ,'product_title',p_data->'title','variant',variant,'specialty_id',specialty,
   'project_id',project,'cohort_id',cohort,'video_id',p_data->'video_id','duration_days',duration,
   'enrollment_required',variant='full',
   'grant_type',case variant when 'membership' then 'membership' when 'single_video' then 'single_video'
     when 'full' then 'project_access' else 'specialty_bundle' end,
   'gift_membership',variant in ('full','video'));
end $$;

create or replace function kidneysphere_release_private.payment_resolve_item(p_item_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare i public.order_items%rowtype; s record; data jsonb; result jsonb;
begin
 select * into i from public.order_items where id=p_item_id;
 if not found then raise exception 'FULFILLMENT_BLOCKED: order item missing'; end if;
 select * into s from kidneysphere_release_private.payment_item_snapshots where order_item_id=i.id;
 if found then
   result:=s.payload;
   if s.order_id<>i.order_id or (result->>'product_id')::uuid<>i.product_id
     or result->>'product_type'<>i.product_type or (result->>'amount_cny')::numeric<>i.amount_cny
     or (result->>'unit_price_cny')::numeric<>i.unit_price_cny or (result->>'quantity')::integer<>i.quantity then
     raise exception 'FULFILLMENT_BLOCKED: order item differs from immutable purchase snapshot';
   end if;
   if result->>'variant'='full' and not exists(select 1 from public.learning_projects lp where lp.id=(result->>'project_id')::uuid) then
     raise exception 'FULFILLMENT_BLOCKED: frozen project no longer exists';
   end if;
   if result->>'variant'='full' and (result->>'cohort_id')::uuid is not null
     and not exists(select 1 from public.cohorts c where c.id=(result->>'cohort_id')::uuid and c.project_id=(result->>'project_id')::uuid) then
     raise exception 'FULFILLMENT_BLOCKED: frozen cohort was removed or moved to another project';
   end if;
   return result||jsonb_build_object('mapping_source',s.mapping_source);
 end if;
 select baseline into data from kidneysphere_release_private.payment_catalog_backups where product_id=i.product_id;
 if data is null or data->>'product_type' is distinct from i.product_type then
   raise exception 'FULFILLMENT_BLOCKED: historical product identity/type is ambiguous';
 end if;
 result:=kidneysphere_release_private.payment_resolve_product(data);
 if i.quantity<>1 or i.unit_price_cny<=0 or i.amount_cny<>i.unit_price_cny then
   raise exception 'FULFILLMENT_BLOCKED: unsupported historical quantity or inconsistent item amount';
 end if;
 return result||jsonb_build_object('order_item_id',i.id,'amount_cny',i.amount_cny,'unit_price_cny',i.unit_price_cny,
   'quantity',i.quantity,'product_title',i.product_title,'mapping_source','legacy_catalog_baseline');
end $$;

-- Lock the referenced entities, then resolve again in the caller. This blocks a
-- cohort being reassigned between validation and enrollment insertion.
create or replace function kidneysphere_release_private.payment_lock_targets(p_order_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform 1 from public.learning_projects lp where lp.id in (
   select (kidneysphere_release_private.payment_resolve_item(i.id)->>'project_id')::uuid
   from public.order_items i where i.order_id=p_order_id) order by lp.id for share;
 perform 1 from public.cohorts c where c.id in (
   select (kidneysphere_release_private.payment_resolve_item(i.id)->>'cohort_id')::uuid
   from public.order_items i where i.order_id=p_order_id) order by c.id for share;
end $$;

-- Storage metadata is authoritative for upload existence and ownership.
create or replace function kidneysphere_release_private.payment_proof_problem(p public.payment_proofs, o public.orders)
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select case
 when p.user_id is distinct from o.user_id or p.order_id is distinct from o.id then 'PROOF_OWNER_MISMATCH'
 when p.amount_cny is distinct from o.total_amount_cny or o.total_amount_cny<=0 then 'PROOF_AMOUNT_MISMATCH'
 when p.proof_bucket is distinct from 'payment_proofs' or nullif(p.proof_path,'') is null
   or split_part(p.proof_path,'/',1)<>o.user_id::text then 'PROOF_PATH_INVALID'
 when not exists(select 1 from storage.objects ob where ob.bucket_id='payment_proofs' and ob.name=p.proof_path
   and coalesce(to_jsonb(ob)->>'owner_id',to_jsonb(ob)->>'owner')=o.user_id::text) then 'PROOF_OBJECT_MISSING_OR_NOT_OWNED'
 when p.review_result='rejected' then 'PROOF_REJECTED'
 else null end;
$$;

create or replace function public.trg_validate_proof_amount()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare o public.orders%rowtype; reason text;
begin
 select * into o from public.orders where id=new.order_id for update;
 if not found then raise exception 'Order not found'; end if;
 -- Never fabricate a paid amount by overwriting what was submitted.
 reason:=kidneysphere_release_private.payment_proof_problem(new,o);
 if reason is not null and reason<>'PROOF_REJECTED' then raise exception '%',reason; end if;
 return new;
end $$;

create or replace function public.create_order_with_items(p_product_id uuid,p_channel text default 'wechat')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=auth.uid(); p public.products%rowtype; o public.orders%rowtype; i public.order_items%rowtype; payload jsonb;
begin
 if uid is null then raise exception 'Not authenticated'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 perform 1 from public.profiles where id=uid for update;
 select * into p from public.products where id=p_product_id and is_active for share;
 if not found then raise exception 'Product not found or inactive'; end if;
 payload:=kidneysphere_release_private.payment_resolve_product(to_jsonb(p));
 perform 1 from public.learning_projects where id=(payload->>'project_id')::uuid for share;
 perform 1 from public.cohorts where id=(payload->>'cohort_id')::uuid for share;
 payload:=kidneysphere_release_private.payment_resolve_product(to_jsonb(p));
 if payload->>'variant'='video' then raise exception 'This replay-only SKU is retired'; end if;
 if p.price_cny<=0 then raise exception 'Product price must be positive'; end if;
 if p_channel is null or p_channel not in ('wechat','alipay','bank_transfer') then p_channel:='wechat'; end if;
 select oo.* into o from public.orders oo where oo.user_id=uid
   and oo.status in ('pending_payment','pending_review') and exists(select 1 from public.order_items oi where oi.order_id=oo.id and oi.product_id=p_product_id)
   order by oo.created_at,oo.id limit 1 for update;
 if found then
   select * into i from public.order_items where order_id=o.id and product_id=p_product_id order by id limit 1;
   -- Return the historical order amount, never today's catalog price.
   return jsonb_build_object('ok',true,'order_id',o.id,'order_no',o.order_no,'total_amount_cny',o.total_amount_cny,
     'product_title',i.product_title,'status',o.status,'reused',true);
 end if;
 insert into public.orders(order_no,user_id,total_amount_cny,status,channel)
 values('KS'||to_char(now() at time zone 'Asia/Shanghai','YYYYMMDD')||replace(gen_random_uuid()::text,'-',''),uid,p.price_cny,'pending_payment',p_channel)
 returning * into o;
 insert into public.order_items(order_id,product_id,product_type,product_title,quantity,unit_price_cny,amount_cny)
 values(o.id,p.id,p.product_type,p.title,1,p.price_cny,p.price_cny) returning * into i;
 insert into kidneysphere_release_private.payment_item_snapshots(order_item_id,order_id,payload,mapping_source)
 values(i.id,o.id,payload||jsonb_build_object('order_item_id',i.id,'amount_cny',i.amount_cny,'unit_price_cny',i.unit_price_cny,'quantity',i.quantity),'purchase_snapshot');
 return jsonb_build_object('ok',true,'order_id',o.id,'order_no',o.order_no,'total_amount_cny',i.amount_cny,'product_title',i.product_title,'status',o.status);
end $$;

create or replace function public.submit_order_for_review(p_order_id uuid,p_contact_wechat text default null,
 p_contact_phone text default null,p_contact_email text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare o public.orders%rowtype; uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'Not authenticated'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 select * into o from public.orders where id=p_order_id for update;
 if o.id is null or o.user_id is distinct from uid then raise exception 'Order not found or not owned'; end if;
 if o.status not in ('pending_payment','rejected','pending_review') then raise exception 'Order cannot be submitted in status %',o.status; end if;
 if not exists(select 1 from public.payment_proofs p where p.order_id=o.id and kidneysphere_release_private.payment_proof_problem(p,o) is null) then
   raise exception '请上传属于本订单、金额一致且真实存在的支付凭证';
 end if;
 update public.orders set status='pending_review',paid_at=coalesce(paid_at,now()),
   contact_wechat=coalesce(p_contact_wechat,contact_wechat),contact_phone=coalesce(p_contact_phone,contact_phone),
   contact_email=coalesce(p_contact_email,contact_email),remark=case when o.status='rejected' then null else remark end
 where id=o.id;
 return jsonb_build_object('ok',true,'status','pending_review');
end $$;

create or replace function public.submit_payment_proof(p_order_id uuid,p_channel text,p_amount_cny numeric,
 p_proof_path text,p_file_hash text,p_payer_name text default null,p_transfer_ref_last4 text default null,
 p_contact_wechat text default null,p_contact_phone text default null,p_contact_email text default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare uid uuid:=auth.uid(); o public.orders%rowtype; p public.payment_proofs%rowtype; reused boolean:=false;
begin
 if uid is null then raise exception 'Not authenticated'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 select * into o from public.orders where id=p_order_id for update;
 if o.id is null or o.user_id is distinct from uid then raise exception 'Order not found or not owned'; end if;
 if p_channel is null or p_channel not in ('wechat','alipay','bank_transfer') then raise exception 'Invalid payment channel'; end if;
 if p_amount_cny is distinct from o.total_amount_cny or p_amount_cny<=0 then raise exception '实付金额与订单金额不一致，请联系管理员核对'; end if;
 if p_file_hash is null or p_file_hash !~ '^[a-fA-F0-9]{64}$' then raise exception 'Invalid payment proof hash'; end if;
 p_file_hash:=lower(p_file_hash);
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-proof:'||p_file_hash,0));
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-proof-path:'||coalesce(p_proof_path,''),0));
 if exists(select 1 from public.payment_proofs where (lower(proof_file_hash)=p_file_hash or (proof_bucket='payment_proofs' and proof_path=p_proof_path)) and order_id<>o.id) then
   raise exception '该支付凭证已用于其他订单，请联系管理员核对';
 end if;
 select * into p from public.payment_proofs where order_id=o.id and lower(proof_file_hash)=p_file_hash order by submitted_at,id limit 1 for update;
 if found and o.status in ('pending_review','approved') and kidneysphere_release_private.payment_proof_problem(p,o) is null then
   return jsonb_build_object('ok',true,'status',o.status,'proof_id',p.id,'reused',true);
 end if;
 if o.status not in ('pending_payment','rejected') then raise exception 'Order cannot accept proof in status %',o.status; end if;
 if p.id is not null and p.review_result is distinct from 'rejected' and kidneysphere_release_private.payment_proof_problem(p,o) is null then
   reused:=true;
 else
   insert into public.payment_proofs(order_id,user_id,channel,amount_cny,proof_bucket,proof_path,proof_file_hash,payer_name,transfer_ref_last4,paid_time)
   values(o.id,uid,p_channel,p_amount_cny,'payment_proofs',p_proof_path,p_file_hash,p_payer_name,p_transfer_ref_last4,now()) returning * into p;
 end if;
 update public.orders set status='pending_review',channel=p_channel,paid_at=coalesce(paid_at,now()),
   contact_wechat=coalesce(p_contact_wechat,contact_wechat),contact_phone=coalesce(p_contact_phone,contact_phone),
   contact_email=coalesce(p_contact_email,contact_email),remark=p_note where id=o.id;
 return jsonb_build_object('ok',true,'status','pending_review','proof_id',p.id,'reused',reused);
end $$;

create or replace function kidneysphere_release_private.payment_fulfillment(p_order_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare o public.orders%rowtype; i record; item jsonb; items jsonb:='[]'; proofs jsonb:='[]';
 blockers jsonb:='[]'; item_total numeric; valid_count integer; result jsonb; fingerprint text; display_items jsonb;
begin
 select * into o from public.orders where id=p_order_id;
 if o.id is null then raise exception 'Order not found'; end if;
 for i in select id from public.order_items where order_id=o.id order by id loop
   begin
     item:=kidneysphere_release_private.payment_resolve_item(i.id);
     items:=items||jsonb_build_array(item||jsonb_build_object(
       'project_title',(select title from public.learning_projects where id=(item->>'project_id')::uuid),
       'cohort_title',(select title from public.cohorts where id=(item->>'cohort_id')::uuid),
       'specialty_name',(select name from public.specialties where id=(item->>'specialty_id')::uuid)));
   exception when others then
     blockers:=blockers||jsonb_build_array('ITEM '||i.id::text||': '||sqlerrm);
   end;
 end loop;
 select sum(amount_cny) into item_total from public.order_items where order_id=o.id;
 if item_total is null or item_total<=0 or item_total is distinct from o.total_amount_cny then
   blockers:=blockers||jsonb_build_array('ORDER_AMOUNT_MISMATCH_OR_NO_ITEMS');
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'valid',reason is null,'reason',reason,'amount_cny',p.amount_cny,
   'user_id',p.user_id,'proof_bucket',p.proof_bucket,'proof_path',p.proof_path,'proof_file_hash',p.proof_file_hash,
   'review_result',p.review_result,'submitted_at',p.submitted_at,'storage_object',
   (select jsonb_build_object('id',ob.id,'updated_at',ob.updated_at,'owner',coalesce(to_jsonb(ob)->>'owner_id',to_jsonb(ob)->>'owner'))
    from storage.objects ob where ob.bucket_id=p.proof_bucket and ob.name=p.proof_path)) order by p.id),'[]'),
   count(*) filter(where reason is null) into proofs,valid_count
 from public.payment_proofs p cross join lateral(select kidneysphere_release_private.payment_proof_problem(p,o) as reason) q
 where p.order_id=o.id;
 if valid_count=0 then blockers:=blockers||jsonb_build_array('NO_VALID_PAYMENT_PROOF'); end if;
 if o.status<>'approved' and exists(select 1 from public.user_entitlements where source_order_id=o.id) then
   blockers:=blockers||jsonb_build_array('EXISTING_ENTITLEMENT_HISTORY_REQUIRES_MANUAL_REVIEW');
 end if;
 if o.status not in ('pending_payment','pending_review','approved') then
   blockers:=blockers||jsonb_build_array('ORDER_STATUS_NOT_APPROVABLE');
 end if;
 result:=jsonb_build_object('ok',true,'order_id',o.id,'order_status',o.status,'total_amount_cny',o.total_amount_cny,
   'mapping_status',case when jsonb_array_length(blockers)=0 then 'ready' else 'blocked' end,
   'blockers',blockers,'items',items,'proof_checks',proofs);
 fingerprint:=md5(result::text);
 select coalesce(jsonb_agg(x||jsonb_build_object(
   'expected_start_at',case when o.status='approved' then e.start_at else now() end,
   'expected_end_at',case when o.status='approved' then e.end_at else now()+make_interval(days=>(x->>'duration_days')::integer) end) order by x->>'order_item_id'),'[]')
 into display_items from jsonb_array_elements(items) x left join lateral (
   select min(ue.start_at) as start_at,max(ue.end_at) as end_at from public.user_entitlements ue
   where ue.source_order_id=o.id and ue.source_product_id=(x->>'product_id')::uuid and ue.entitlement_type=x->>'grant_type'
   having count(*)=1) e on true;
 return result||jsonb_build_object('items',display_items,'review_fingerprint',fingerprint,
   'expected_start_at',coalesce(o.approved_at,now()),
   'duration_basis','权益从管理员审核通过时起算；重复审批和补报名不延长权益');
end $$;

create or replace function public.admin_get_order_fulfillment(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 return kidneysphere_release_private.payment_fulfillment(p_order_id);
end $$;

create or replace function public.admin_approve_order(p_order_id uuid,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 raise exception '请先打开审核详情，确认实际到账，再使用 admin_approve_order_verified 审批';
end $$;

create or replace function public.admin_approve_order_verified(p_order_id uuid,p_payment_received boolean,
 p_review_fingerprint text,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare o public.orders%rowtype; uid uuid; review jsonb; item jsonb; start_time timestamptz:=now();
 duration integer; end_time timestamptz; granted integer:=0; template_id uuid; gift_duration integer; gift_codes text;
 member public.user_entitlements%rowtype;
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 if p_payment_received is distinct from true then raise exception '必须由管理员核实真实到账后确认'; end if;
 select user_id into uid from public.orders where id=p_order_id;
 if uid is null then raise exception 'Order not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 perform 1 from public.profiles where id=uid for update;
 select * into o from public.orders where id=p_order_id for update;
 if o.status='approved' then return jsonb_build_object('ok',true,'already_approved',true,'enrollments_created',0); end if;
 if o.status not in ('pending_payment','pending_review') then raise exception 'Order status % cannot be approved',o.status; end if;
 -- Locks prevent proof edits/deletion and changed storage metadata during review.
 perform 1 from public.order_items where order_id=o.id order by id for update;
 perform 1 from public.payment_proofs where order_id=o.id order by id for update;
 perform 1 from storage.objects ob where exists(select 1 from public.payment_proofs p where p.order_id=o.id
   and ob.bucket_id=p.proof_bucket and ob.name=p.proof_path) order by ob.id for share;
 perform kidneysphere_release_private.payment_lock_targets(o.id);
 review:=kidneysphere_release_private.payment_fulfillment(o.id);
 if review->>'mapping_status'<>'ready' then raise exception 'FULFILLMENT_BLOCKED: %',review->'blockers'; end if;
 if p_review_fingerprint is null or p_review_fingerprint<>review->>'review_fingerprint' then
   raise exception 'REVIEW_CHANGED: 订单、权益映射或支付凭证已变化，请重新打开审核详情';
 end if;
 if exists(select 1 from kidneysphere_release_private.payment_approval_receipts where order_id=o.id)
   or exists(select 1 from public.project_enrollments where source_order_id=o.id) then
   raise exception 'FULFILLMENT_BLOCKED: previous approval/enrollment history must not be reactivated';
 end if;
 for item in select value from jsonb_array_elements(review->'items') loop
   insert into kidneysphere_release_private.payment_item_snapshots(order_item_id,order_id,payload,mapping_source)
   values((item->>'order_item_id')::uuid,o.id,item,item->>'mapping_source') on conflict(order_item_id) do nothing;
   duration:=(item->>'duration_days')::integer; end_time:=start_time+make_interval(days=>duration);
   insert into public.user_entitlements(user_id,entitlement_type,source_order_id,source_product_id,
     membership_product_id,specialty_id,video_id,project_id,cohort_id,start_at,end_at,status,granted_by,grant_reason)
   values(o.user_id,item->>'grant_type',o.id,(item->>'product_id')::uuid,
     case when item->>'variant'='membership' then (item->>'product_id')::uuid end,
     (item->>'specialty_id')::uuid,case when item->>'variant'='single_video' then (item->>'video_id')::uuid end,
     (item->>'project_id')::uuid,(item->>'cohort_id')::uuid,start_time,end_time,'active',auth.uid(),'order_approved');
   if item->>'variant'='membership' then
     update public.profiles set membership_status='member' where id=o.user_id;
   elsif item->>'variant'='single_video' then
     perform public.check_video_auto_upgrade(o.user_id,(item->>'specialty_id')::uuid);
   elsif item->>'variant'='full' then
     insert into public.project_enrollments(user_id,project_id,cohort_id,source_order_id,enrollment_status,
       approval_status,approved_by,approved_at,joined_group_status)
     values(o.user_id,(item->>'project_id')::uuid,(item->>'cohort_id')::uuid,o.id,'confirmed','approved',auth.uid(),start_time,
       case when (item->>'cohort_id')::uuid is null then 'not_required' else 'eligible_for_group' end);
     granted:=granted+1;
   end if;
 end loop;
 -- Preserve training gift eligibility, duration=max purchased training duration.
 -- Keep each order's gift provenance separate so refund/revocation is reversible;
 -- overlapping existing memberships continue to work and are never shortened.
 select max((x->>'duration_days')::integer),string_agg(x->>'product_code',', ' order by x->>'product_code')
 into gift_duration,gift_codes from jsonb_array_elements(review->'items') x where (x->>'gift_membership')::boolean;
 if gift_duration is not null then
   end_time:=start_time+make_interval(days=>gift_duration);
   select * into member from public.user_entitlements where user_id=o.user_id and entitlement_type='membership'
     and status='active' and start_at<=start_time and (end_at is null or end_at>start_time)
     order by coalesce(end_at,'infinity'::timestamptz) desc limit 1 for update;
   -- Every training order retains its own gift even when another membership lasts longer.
   -- Revoking that other order must not remove this order's promised membership.
   if gift_duration is not null then
     insert into public.user_entitlements(user_id,entitlement_type,source_order_id,start_at,end_at,status,granted_by,grant_reason)
     values(o.user_id,'membership',o.id,start_time,end_time,'active',auth.uid(),'培训项目赠送会员 · '||gift_codes);
   end if;
   update public.profiles set membership_status='member' where id=o.user_id;
 end if;
 update public.payment_proofs p set review_result='approved',reviewed_at=start_time,reviewed_by=auth.uid(),review_note=p_note
 where p.order_id=o.id and kidneysphere_release_private.payment_proof_problem(p,o) is null;
 update public.orders set status='approved',approved_at=start_time,approved_by=auth.uid(),remark=coalesce(p_note,remark) where id=o.id;
 insert into kidneysphere_release_private.payment_approval_receipts values(o.id,auth.uid(),start_time,p_review_fingerprint,true);
 select id into template_id from public.notification_templates where code='order_approved' and is_active limit 1;
 if template_id is not null then
   insert into public.notification_jobs(template_id,user_id,related_order_id,channel,status,sent_at,payload_json)
   values(template_id,o.user_id,o.id,'site','sent',start_time,jsonb_build_object('order_no',o.order_no,'amount',o.total_amount_cny));
 end if;
 insert into public.audit_logs(operator_id,action,target_type,target_id,after_json)
 values(auth.uid(),'order_approved','order',o.id::text,jsonb_build_object('order_no',o.order_no,'user_id',o.user_id,
   'amount',o.total_amount_cny,'note',p_note,'payment_received',true,'review_fingerprint',p_review_fingerprint,'enrollments_created',granted));
 -- Other pending orders, including any with payment proofs, are never cancelled.
 return jsonb_build_object('ok',true,'enrollments_created',granted);
end $$;

-- Read-only repair assessment: exact FULL identity + one existing unrevoked,
-- currently active project entitlement. No order, proof, or membership extension.
create or replace function kidneysphere_release_private.payment_repair_assessment(p_order_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare o public.orders%rowtype; i record; item jsonb; ue public.user_entitlements%rowtype;
 n integer; missing integer:=0; items jsonb:='[]'; issue text:='COMPLETE'; eligible boolean:=true;
begin
 select * into o from public.orders where id=p_order_id;
 if o.id is null then raise exception 'Order not found'; end if;
 if o.status<>'approved' then return jsonb_build_object('issue_code','ORDER_NOT_APPROVED','can_repair',false,'items',items); end if;
 for i in select * from public.order_items where order_id=o.id order by id loop
   begin item:=kidneysphere_release_private.payment_resolve_item(i.id);
   exception when others then
     return jsonb_build_object('issue_code','AMBIGUOUS_MAPPING','can_repair',false,'items',items,'reason',sqlerrm);
   end;
   if item->>'variant'<>'full' then continue; end if;
   select count(*) into n from public.user_entitlements e where e.source_order_id=o.id and e.source_product_id=i.product_id
     and e.entitlement_type='project_access';
   if n<>1 then eligible:=false; issue:='MISSING_OR_AMBIGUOUS_ENTITLEMENT';
   else
     select * into ue from public.user_entitlements e where e.source_order_id=o.id and e.source_product_id=i.product_id and e.entitlement_type='project_access';
     if ue.user_id<>o.user_id or ue.specialty_id is distinct from (item->>'specialty_id')::uuid
       or (ue.project_id is not null and ue.project_id<>(item->>'project_id')::uuid)
       or ue.cohort_id is distinct from (item->>'cohort_id')::uuid then
       eligible:=false; issue:='ENTITLEMENT_MAPPING_CONFLICT';
     elsif ue.status<>'active' or ue.start_at>now() or (ue.end_at is not null and ue.end_at<=now()) then
       eligible:=false; issue:='ENTITLEMENT_NOT_ACTIVE';
     else
       select count(*) into n from public.project_enrollments pe where pe.source_order_id=o.id and pe.user_id=o.user_id
         and pe.project_id=(item->>'project_id')::uuid and pe.cohort_id is not distinct from (item->>'cohort_id')::uuid;
       if n>1 or exists(select 1 from public.project_enrollments pe where pe.source_order_id=o.id
         and pe.project_id=(item->>'project_id')::uuid and (pe.enrollment_status<>'confirmed' or pe.approval_status<>'approved'
           or pe.user_id<>o.user_id or pe.cohort_id is distinct from (item->>'cohort_id')::uuid)) then
         eligible:=false; issue:='ENROLLMENT_HISTORY_CONFLICT';
       elsif n=0 or ue.project_id is null then
         missing:=missing+1;
         item:=item||jsonb_build_object('entitlement_id',ue.id,'repair_required',true,'access_start_at',ue.start_at,'access_end_at',ue.end_at);
       end if;
     end if;
   end if;
   items:=items||jsonb_build_array(item);
 end loop;
 if exists(select 1 from public.project_enrollments pe where pe.source_order_id=o.id and not exists(
   select 1 from jsonb_array_elements(items) x where (x->>'project_id')::uuid=pe.project_id
     and (x->>'cohort_id')::uuid is not distinct from pe.cohort_id and pe.user_id=o.user_id)) then
   eligible:=false; issue:='ENROLLMENT_MAPPING_CONFLICT';
 end if;
 if eligible and missing>0 then issue:='MISSING_FULL_ENROLLMENT'; end if;
 return jsonb_build_object('issue_code',issue,'can_repair',eligible and missing>0,'missing_count',missing,'items',items);
end $$;

create or replace function public.admin_list_payment_enrollment_issues(p_limit integer default 100,p_offset integer default 0)
returns table(order_id uuid,order_no text,user_id uuid,approved_at timestamptz,issue_code text,can_repair boolean,items jsonb)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 return query select o.id,o.order_no,o.user_id,o.approved_at,a->>'issue_code',(a->>'can_repair')::boolean,a->'items'
 from public.orders o cross join lateral(select kidneysphere_release_private.payment_repair_assessment(o.id) as a) q
 where o.status='approved' and a->>'issue_code'<>'COMPLETE'
 order by o.approved_at desc,o.id limit least(greatest(coalesce(p_limit,100),1),500) offset greatest(coalesce(p_offset,0),0);
end $$;

create or replace function public.admin_repair_order_enrollment(p_order_id uuid,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare o public.orders%rowtype; uid uuid; a jsonb; item jsonb; n integer:=0;
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 select user_id into uid from public.orders where id=p_order_id;
 if uid is null then raise exception 'Order not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 perform 1 from public.profiles where id=uid for update;
 select * into o from public.orders where id=p_order_id for update;
 perform 1 from public.order_items where order_id=o.id order by id for update;
 perform 1 from public.user_entitlements where source_order_id=o.id order by id for update;
 perform 1 from public.project_enrollments where source_order_id=o.id order by id for update;
 perform kidneysphere_release_private.payment_lock_targets(o.id);
 a:=kidneysphere_release_private.payment_repair_assessment(o.id);
 if a->>'issue_code'='COMPLETE' then return jsonb_build_object('ok',true,'repaired_count',0,'already_complete',true); end if;
 if (a->>'can_repair')::boolean is distinct from true then raise exception 'REPAIR_BLOCKED: %',a->>'issue_code'; end if;
 for item in select value from jsonb_array_elements(a->'items') where (value->>'repair_required')::boolean loop
   -- Preserve every entitlement timestamp/status; bind only an unambiguous null project.
   update public.user_entitlements set project_id=(item->>'project_id')::uuid
     where id=(item->>'entitlement_id')::uuid and project_id is null;
   insert into kidneysphere_release_private.payment_item_snapshots(order_item_id,order_id,payload,mapping_source)
   values((item->>'order_item_id')::uuid,o.id,item,item->>'mapping_source') on conflict(order_item_id) do nothing;
   if not exists(select 1 from public.project_enrollments pe where pe.source_order_id=o.id and pe.user_id=o.user_id
     and pe.project_id=(item->>'project_id')::uuid and pe.cohort_id is not distinct from (item->>'cohort_id')::uuid) then
     insert into public.project_enrollments(user_id,project_id,cohort_id,source_order_id,enrollment_status,approval_status,
       approved_by,approved_at,joined_group_status,notes)
     values(o.user_id,(item->>'project_id')::uuid,(item->>'cohort_id')::uuid,o.id,'confirmed','approved',auth.uid(),o.approved_at,
       case when (item->>'cohort_id')::uuid is null then 'not_required' else 'eligible_for_group' end,'历史FULL缺报名修复；未新增或延长权益');
   end if;
   n:=n+1;
 end loop;
 insert into public.audit_logs(operator_id,action,target_type,target_id,after_json)
 values(auth.uid(),'order_full_enrollment_repaired','order',o.id::text,jsonb_build_object('repaired_count',n,'note',p_note,'items',a->'items'));
 return jsonb_build_object('ok',true,'repaired_count',n,'already_complete',false);
end $$;

create or replace function kidneysphere_release_private.payment_learning_rows(p_user_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare pe record; i record; item jsonb; chosen jsonb; ent public.user_entitlements%rowtype;
 matches integer; n integer; state text; active boolean; result jsonb:='[]';
begin
 if p_user_id is null then return result; end if;
 for pe in select e.*,lp.title as project_title,lp.cover_url as project_cover_url,c.title as cohort_title,
   c.start_date as cohort_start_date,c.end_date as cohort_end_date,c.group_qr_url,
   o.status as order_status from public.project_enrollments e
   join public.learning_projects lp on lp.id=e.project_id
   left join public.cohorts c on c.id=e.cohort_id and c.project_id=e.project_id
   left join public.orders o on o.id=e.source_order_id and o.user_id=e.user_id
   where e.user_id=p_user_id order by e.created_at desc,e.id loop
   matches:=0; chosen:=null; ent:=null; state:='inactive'; active:=false;
   for i in select id from public.order_items where order_id=pe.source_order_id order by id loop
     begin
       item:=kidneysphere_release_private.payment_resolve_item(i.id);
       if item->>'variant'='full' and (item->>'project_id')::uuid=pe.project_id
         and (item->>'cohort_id')::uuid is not distinct from pe.cohort_id then
         matches:=matches+1; chosen:=item;
       end if;
     exception when others then state:='ambiguous'; end;
   end loop;
   -- Preserve the existing admin_batch_grant_project contract: both rows have
   -- no source order. Match one exact user/project/cohort entitlement only;
   -- never borrow rights from a purchased order or infer a purchased product.
   if pe.source_order_id is null then
     select count(*) into n from public.user_entitlements e where e.user_id=p_user_id
       and e.source_order_id is null and e.entitlement_type='project_access'
       and e.project_id=pe.project_id and e.cohort_id is not distinct from pe.cohort_id;
     if n=1 then
       select * into ent from public.user_entitlements e where e.user_id=p_user_id
         and e.source_order_id is null and e.entitlement_type='project_access'
         and e.project_id=pe.project_id and e.cohort_id is not distinct from pe.cohort_id;
       chosen:=jsonb_build_object('specialty_id',ent.specialty_id);
       active:=pe.enrollment_status='confirmed' and pe.approval_status='approved'
         and ent.status='active' and ent.start_at<=now() and (ent.end_at is null or ent.end_at>now());
       state:=case when active then 'active' when ent.status='revoked' then 'revoked'
         when ent.status='expired' or ent.end_at<=now() then 'expired'
         when ent.start_at>now() then 'upcoming' else 'inactive' end;
     elsif n>1 then state:='ambiguous';
     end if;
   elsif matches=1 and state<>'ambiguous' then
     select count(*) into n from public.user_entitlements e where e.user_id=p_user_id
       and e.source_order_id=pe.source_order_id and e.source_product_id=(chosen->>'product_id')::uuid
       and e.entitlement_type='project_access' and e.project_id=pe.project_id
       and e.specialty_id is not distinct from (chosen->>'specialty_id')::uuid
       and e.cohort_id is not distinct from pe.cohort_id;
     if n=1 then
       select * into ent from public.user_entitlements e where e.user_id=p_user_id
         and e.source_order_id=pe.source_order_id and e.source_product_id=(chosen->>'product_id')::uuid
         and e.entitlement_type='project_access' and e.project_id=pe.project_id
         and e.specialty_id is not distinct from (chosen->>'specialty_id')::uuid
         and e.cohort_id is not distinct from pe.cohort_id;
       active:=pe.order_status='approved' and pe.enrollment_status='confirmed' and pe.approval_status='approved'
         and ent.status='active' and ent.start_at<=now() and (ent.end_at is null or ent.end_at>now());
       state:=case when active then 'active' when pe.order_status='refunded' then 'refunded'
         when ent.status='revoked' then 'revoked' when ent.status='expired' or ent.end_at<=now() then 'expired'
         when ent.start_at>now() then 'upcoming' else 'inactive' end;
     elsif n>1 then state:='ambiguous'; chosen:=null;
     end if;
   elsif matches<>1 then state:='ambiguous'; chosen:=null;
   end if;
   result:=result||jsonb_build_array(jsonb_build_object('id',pe.id,'project_id',pe.project_id,'cohort_id',pe.cohort_id,
     'enrollment_status',pe.enrollment_status,'approval_status',pe.approval_status,'joined_group_status',pe.joined_group_status,
     'created_at',pe.created_at,'project_title',pe.project_title,'project_cover_url',pe.project_cover_url,
     'cohort_title',pe.cohort_title,'cohort_start_date',pe.cohort_start_date,'cohort_end_date',pe.cohort_end_date,
     'group_qr_url',case when active and pe.source_order_id is not null and pe.cohort_id is not null then pe.group_qr_url end,
     'source_order_id',pe.source_order_id,'source_product_id',chosen->'product_id','specialty_id',chosen->'specialty_id',
     'product_title',chosen->'product_title','access_start_at',ent.start_at,'access_end_at',ent.end_at,
     'is_access_active',coalesce(active,false),'access_status',state));
 end loop;
 return result;
end $$;

create or replace function public.get_my_enrollments()
returns table(id uuid,project_id uuid,cohort_id uuid,enrollment_status text,approval_status text,
 joined_group_status text,created_at timestamptz,project_title text,project_cover_url text,cohort_title text,
 cohort_start_date date,cohort_end_date date,group_qr_url text)
language sql stable security definer set search_path=pg_catalog as $$
 select * from jsonb_to_recordset(kidneysphere_release_private.payment_learning_rows(auth.uid())) as x(
 id uuid,project_id uuid,cohort_id uuid,enrollment_status text,approval_status text,
 joined_group_status text,created_at timestamptz,project_title text,project_cover_url text,cohort_title text,
 cohort_start_date date,cohort_end_date date,group_qr_url text);
$$;
create or replace function public.get_my_learning_enrollments()
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select kidneysphere_release_private.payment_learning_rows(auth.uid());
$$;
create or replace function public.admin_get_cohorts(p_project_id uuid default null)
returns setof public.cohorts language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 return query select * from public.cohorts where p_project_id is null or project_id=p_project_id order by created_at desc,id;
end $$;
create or replace function public.admin_get_study_groups()
returns setof public.study_groups language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 return query select * from public.study_groups order by created_at desc,id;
end $$;
create or replace function public.get_payment_enrollment_release()
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('payment_release','payment-enrollment-20260914-v1',
 'payment_state',(select state from kidneysphere_release_private.payment_enrollment_releases where release_key='payment-enrollment-20260914-v1'),
 'pricing_release','training-prices-20260914-v1',
 'pricing_state',(select state from kidneysphere_release_private.training_price_releases where release_key='training-prices-20260914-v1'));
$$;

-- Admin state changes are also atomic after direct commerce writes are removed.
insert into kidneysphere_release_private.payment_function_backups(release_key,signature,before_value)
select 'payment-enrollment-20260914-v1',s,kidneysphere_release_private.payment_function_state(s)
from unnest(array['public.admin_reject_order(uuid,text)','public.admin_revoke_order_approval(uuid,text)']) s on conflict do nothing;
create or replace function kidneysphere_release_private.payment_revoke_order(p_order_id uuid,p_note text,p_target_status text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare uid uuid; o public.orders%rowtype;
begin
 select user_id into uid from public.orders where id=p_order_id;
 if uid is null then raise exception 'Order not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 perform 1 from public.profiles where id=uid for update;
 select * into o from public.orders where id=p_order_id for update;
 if p_target_status='pending_review' and o.status<>'approved' then raise exception 'Only approved orders can revoke approval'; end if;
 if o.status not in ('approved','pending_payment','pending_review','rejected') then raise exception 'Order cannot be rejected in status %',o.status; end if;
 update public.user_entitlements set status='revoked' where source_order_id=o.id and status='active';
 update public.project_enrollments set enrollment_status='cancelled',approval_status='rejected',joined_group_status='expired'
   where source_order_id=o.id;
 update public.orders set status=p_target_status,remark=p_note,
   rejected_at=case when p_target_status='rejected' then now() else rejected_at end,
   rejected_by=case when p_target_status='rejected' then auth.uid() else rejected_by end where id=o.id;
 if p_target_status='rejected' then
   -- Invalid legacy proofs may fail the new validation trigger; review only those
   -- that still match this order and an existing owned upload.
   update public.payment_proofs p set review_result='rejected',reviewed_at=now(),reviewed_by=auth.uid(),review_note=p_note
   where p.order_id=o.id and kidneysphere_release_private.payment_proof_problem(p,o) is null;
 end if;
 if not exists(select 1 from public.user_entitlements where user_id=uid and entitlement_type='membership'
   and status='active' and start_at<=now() and (end_at is null or end_at>now())) then
   update public.profiles set membership_status='none' where id=uid and membership_status='member';
 end if;
 insert into public.audit_logs(operator_id,action,target_type,target_id,after_json)
 values(auth.uid(),case when p_target_status='rejected' then 'order_rejected' else 'order_approval_revoked' end,'order',o.id::text,
   jsonb_build_object('note',p_note,'status',p_target_status,'entitlements_revoked',true));
 return jsonb_build_object('ok',true,'status',p_target_status);
end $$;
create or replace function public.admin_reject_order(p_order_id uuid,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 return kidneysphere_release_private.payment_revoke_order(p_order_id,p_note,'rejected');
end $$;
create or replace function public.admin_revoke_order_approval(p_order_id uuid,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 return kidneysphere_release_private.payment_revoke_order(p_order_id,p_note,'pending_review');
end $$;

insert into kidneysphere_release_private.payment_function_backups(release_key,signature,before_value)
values('payment-enrollment-20260914-v1','public.admin_review_manual_enrollment(uuid,boolean,text)',
 kidneysphere_release_private.payment_function_state('public.admin_review_manual_enrollment(uuid,boolean,text)')) on conflict do nothing;
create or replace function public.admin_review_manual_enrollment(p_enrollment_id uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare pe public.project_enrollments%rowtype; uid uuid;
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 if p_approve is null then raise exception 'Approval decision required'; end if;
 select user_id into uid from public.project_enrollments where id=p_enrollment_id;
 if uid is null then raise exception 'Enrollment not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 select * into pe from public.project_enrollments where id=p_enrollment_id for update;
 if pe.source_order_id is not null then raise exception '付费订单报名请使用订单审核，不能手动修改'; end if;
 if pe.enrollment_status<>'pending' or pe.approval_status<>'pending' then raise exception 'Only pending manual enrollments can be reviewed'; end if;
 if pe.cohort_id is not null and not exists(select 1 from public.cohorts where id=pe.cohort_id and project_id=pe.project_id) then
   raise exception 'Enrollment cohort does not belong to project';
 end if;
 update public.project_enrollments set enrollment_status=case when p_approve then 'confirmed' else 'cancelled' end,
   approval_status=case when p_approve then 'approved' else 'rejected' end,approved_by=auth.uid(),approved_at=now(),
   joined_group_status='not_required',notes=coalesce(p_note,notes) where id=pe.id;
 insert into public.audit_logs(operator_id,action,target_type,target_id,after_json)
 values(auth.uid(),'manual_enrollment_reviewed','project_enrollment',pe.id::text,jsonb_build_object('approved',p_approve,'note',p_note));
 return jsonb_build_object('ok',true);
end $$;

insert into kidneysphere_release_private.payment_function_backups(release_key,signature,before_value)
values('payment-enrollment-20260914-v1','public.admin_revert_rejection(uuid,text)',
 kidneysphere_release_private.payment_function_state('public.admin_revert_rejection(uuid,text)')) on conflict do nothing;
create or replace function public.admin_revert_rejection(p_order_id uuid,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare o public.orders%rowtype; uid uuid;
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Forbidden: admin only'; end if;
 select user_id into uid from public.orders where id=p_order_id;
 if uid is null then raise exception 'Order not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ks-payment-user:'||uid::text,0));
 select * into o from public.orders where id=p_order_id for update;
 if o.status<>'rejected' then raise exception 'Only rejected orders can be returned to review'; end if;
 update public.orders set status='pending_review',rejected_at=null,rejected_by=null,
   remark=coalesce(p_note,'管理员撤回驳回: '||coalesce(remark,'')) where id=o.id;
 insert into public.audit_logs(operator_id,action,target_type,target_id,after_json)
 values(auth.uid(),'order_rejection_reverted','order',o.id::text,jsonb_build_object('note',p_note));
 return jsonb_build_object('ok',true);
end $$;

-- All RPCs check identity themselves. No public execution of privileged helpers.
do $$ declare r record; role_name text; safe_columns text; commerce_table text; commerce_columns text;
begin
 for r in select signature from kidneysphere_release_private.payment_function_backups loop
   execute format('revoke all on function %s from public',r.signature);
   foreach role_name in array array['anon','authenticated'] loop
     if exists(select 1 from pg_roles where rolname=role_name) then
       execute format('revoke all on function %s from %I',r.signature,role_name);
     end if;
   end loop;
   if r.signature not in ('public.trg_validate_proof_amount()','public.admin_approve_order(uuid,text)') then
     execute format('grant execute on function %s to authenticated',r.signature);
   end if;
 end loop;
 grant execute on function public.get_payment_enrollment_release() to anon,authenticated;
 foreach role_name in array array['public','anon','authenticated'] loop
   if role_name='public' or exists(select 1 from pg_roles where rolname=role_name) then
     execute format('revoke insert,update,delete on public.orders,public.order_items,public.payment_proofs,public.project_enrollments from %s',
       case when role_name='public' then 'public' else quote_ident(role_name) end);
     foreach commerce_table in array array['orders','order_items','payment_proofs','project_enrollments'] loop
       select string_agg(quote_ident(attname),',' order by attnum) into commerce_columns from pg_attribute
       where attrelid=to_regclass('public.'||commerce_table) and attnum>0 and not attisdropped;
       execute format('revoke insert(%s),update(%s) on public.%I from %s',commerce_columns,commerce_columns,commerce_table,
         case when role_name='public' then 'public' else quote_ident(role_name) end);
     end loop;
     -- Removing table SELECT is necessary: a column revoke alone cannot override it.
     execute format('revoke select on public.cohorts from %s',case when role_name='public' then 'public' else quote_ident(role_name) end);
     execute format('revoke select(group_qr_url,group_qr_backup_url) on public.cohorts from %s',case when role_name='public' then 'public' else quote_ident(role_name) end);
     execute format('revoke select on public.study_groups from %s',case when role_name='public' then 'public' else quote_ident(role_name) end);
     execute format('revoke select(qr_url,qr_backup_url) on public.study_groups from %s',case when role_name='public' then 'public' else quote_ident(role_name) end);
   end if;
 end loop;
 select string_agg(quote_ident(attname),',' order by attnum) into safe_columns from pg_attribute
 where attrelid='public.cohorts'::regclass and attnum>0 and not attisdropped and attname not in ('group_qr_url','group_qr_backup_url');
 execute format('grant select(%s) on public.cohorts to anon,authenticated',safe_columns);
 select string_agg(quote_ident(attname),',' order by attnum) into safe_columns from pg_attribute
 where attrelid='public.study_groups'::regclass and attnum>0 and not attisdropped and attname not in ('qr_url','qr_backup_url');
 execute format('grant select(%s) on public.study_groups to anon,authenticated',safe_columns);
end $$;

-- ACL snapshots are canonical arrays, so an implicit default ACL and an explicit
-- equivalent grant compare equal after restoration. Grant options are preserved.
create or replace function kidneysphere_release_private.payment_restore_acl(p_kind text,p_name text,p_target jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare acl jsonb; current_acl jsonb; r record; c record; who text; object_name text;
begin
 if p_kind='function' then
   current_acl:=kidneysphere_release_private.payment_function_state(p_name)->'acl'; object_name:=p_name;
 elsif p_kind='table' then
   current_acl:=kidneysphere_release_private.payment_table_state(p_name)->'acl'; object_name:='public.'||quote_ident(p_name);
 else raise exception 'Unsupported ACL kind'; end if;
 for r in select distinct (v->>'grantee')::oid as grantee from jsonb_array_elements(coalesce(current_acl,'[]')||coalesce(p_target->'acl','[]')) v loop
   who:=case when r.grantee=0 then 'public' else quote_ident(pg_get_userbyid(r.grantee)) end;
   execute format('revoke all on %s %s from %s',p_kind,object_name,who);
 end loop;
 if p_kind='table' then
   for c in select v->>'name' as name,v->'acl' as acl from jsonb_array_elements(kidneysphere_release_private.payment_table_state(p_name)->'columns') v loop
     for r in select distinct (v->>'grantee')::oid as grantee from jsonb_array_elements(coalesce(c.acl,'[]')) v loop
       who:=case when r.grantee=0 then 'public' else quote_ident(pg_get_userbyid(r.grantee)) end;
       execute format('revoke all(%I) on table %s from %s',c.name,object_name,who);
     end loop;
   end loop;
 end if;
 for r in select v from jsonb_array_elements(coalesce(p_target->'acl','[]')) v loop
   who:=case when (r.v->>'grantee')::oid=0 then 'public' else quote_ident(pg_get_userbyid((r.v->>'grantee')::oid)) end;
   execute format('grant %s on %s %s to %s%s',r.v->>'privilege_type',p_kind,object_name,who,
     case when (r.v->>'is_grantable')::boolean then ' with grant option' else '' end);
 end loop;
 if p_kind='table' then
   for c in select v->>'name' as name,v->'acl' as acl from jsonb_array_elements(p_target->'columns') v loop
     for r in select v from jsonb_array_elements(coalesce(c.acl,'[]')) v loop
       who:=case when (r.v->>'grantee')::oid=0 then 'public' else quote_ident(pg_get_userbyid((r.v->>'grantee')::oid)) end;
       execute format('grant %s(%I) on table %s to %s%s',r.v->>'privilege_type',c.name,object_name,who,
         case when (r.v->>'is_grantable')::boolean then ' with grant option' else '' end);
     end loop;
   end loop;
 end if;
end $$;

create or replace function kidneysphere_release_private.restore_payment_enrollment_20260914()
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare st text; r record;
begin
 perform pg_advisory_xact_lock(hashtextextended('kidneysphere-payment-enrollment-20260914-v1',0));
 lock table public.products,public.orders,public.order_items,public.payment_proofs,public.project_enrollments,public.cohorts,public.study_groups in share row exclusive mode;
 select state into st from kidneysphere_release_private.payment_enrollment_releases
 where release_key='payment-enrollment-20260914-v1' for update;
 if st is null then raise exception 'No payment enrollment backup exists'; end if;
 if st='rolled_back' then return jsonb_build_object('status','ALREADY_ROLLED_BACK'); end if;
 for r in select * from kidneysphere_release_private.payment_function_backups loop
   if kidneysphere_release_private.payment_function_state(r.signature) is distinct from r.after_value then
     raise exception 'PAYMENT_ROLLBACK_CONFLICT: function % changed',r.signature;
   end if;
 end loop;
 for r in select * from kidneysphere_release_private.payment_table_backups loop
   if kidneysphere_release_private.payment_table_state(r.table_name) is distinct from r.after_value then
     raise exception 'PAYMENT_ROLLBACK_CONFLICT: table ACL % changed',r.table_name;
   end if;
 end loop;
 for r in select b.*,p.id as live_id,jsonb_build_object('project_id',p.project_id,'cohort_id',p.cohort_id) as actual
   from kidneysphere_release_private.payment_catalog_backups b left join public.products p on p.id=b.product_id loop
   if r.live_id is null or r.actual is distinct from r.after_binding then raise exception 'PAYMENT_ROLLBACK_CONFLICT: product binding % changed',r.product_id; end if;
 end loop;
 -- Restore old functions first, then remove newly introduced RPCs. Private runtime
 -- functions/snapshots remain available for future reapplication and audit.
 for r in select * from kidneysphere_release_private.payment_function_backups where before_value is not null loop
   execute r.before_value->>'definition';
   perform kidneysphere_release_private.payment_restore_acl('function',r.signature,r.before_value);
 end loop;
 for r in select * from kidneysphere_release_private.payment_function_backups where before_value is null loop
   execute format('drop function %s',r.signature);
 end loop;
 for r in select * from kidneysphere_release_private.payment_table_backups loop
   perform kidneysphere_release_private.payment_restore_acl('table',r.table_name,r.before_value);
 end loop;
 update public.products p set project_id=(b.before_binding->>'project_id')::uuid,cohort_id=(b.before_binding->>'cohort_id')::uuid,updated_at=now()
 from kidneysphere_release_private.payment_catalog_backups b where p.id=b.product_id and b.before_binding is distinct from b.after_binding;
 update kidneysphere_release_private.payment_enrollment_releases set state='rolled_back',rolled_back_at=now()
 where release_key='payment-enrollment-20260914-v1';
 return jsonb_build_object('status','ROLLED_BACK','customer_data_preserved',true);
end $$;

-- Save after-state only once; reruns must produce the identical release code/ACL.
do $$ declare r record; v jsonb;
begin
 for r in select * from kidneysphere_release_private.payment_function_backups loop
   v:=kidneysphere_release_private.payment_function_state(r.signature);
   if r.after_value is not null and r.after_value is distinct from v then raise exception 'PAYMENT_RELEASE_CONFLICT: replacement function % differs from saved release',r.signature; end if;
   update kidneysphere_release_private.payment_function_backups set after_value=v where signature=r.signature;
 end loop;
 for r in select * from kidneysphere_release_private.payment_table_backups loop
   v:=kidneysphere_release_private.payment_table_state(r.table_name);
   if r.after_value is not null and r.after_value is distinct from v then raise exception 'PAYMENT_RELEASE_CONFLICT: replacement ACL % differs from saved release',r.table_name; end if;
   update kidneysphere_release_private.payment_table_backups set after_value=v where table_name=r.table_name;
 end loop;
 insert into kidneysphere_release_private.payment_enrollment_releases(release_key,state)
 values('payment-enrollment-20260914-v1','applied')
 on conflict(release_key) do update set state='applied',applied_at=now(),rolled_back_at=null;
end $$;

revoke all on all tables in schema kidneysphere_release_private from public;
revoke all on all functions in schema kidneysphere_release_private from public;
do $$ declare r text; begin
 foreach r in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=r) then
     execute format('revoke all on schema kidneysphere_release_private from %I',r);
     execute format('revoke all on all tables in schema kidneysphere_release_private from %I',r);
     execute format('revoke all on all functions in schema kidneysphere_release_private from %I',r);
   end if;
 end loop;
end $$;
commit;
