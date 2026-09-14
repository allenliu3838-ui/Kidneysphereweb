/**
 * Real PostgreSQL execution of the payment/enrollment release using PGlite.
 * No Supabase client, connection string, network call or production database.
 *
 * PGLITE_PACKAGE=/absolute/path/to/@electric-sql/pglite \
 *   node --test tests/payment-enrollment-sql.test.mjs
 *
 * The relevant original schema, RLS policies, triggers and RPC definitions are
 * loaded from the checked-in migrations. Only external auth/storage tables and
 * unrelated profile/video/card fields are represented by local fixtures.
 * PGlite has one connection: retries are exercised, concurrent transaction races
 * are NOT claimed as covered. Lock ordering is checked separately in SQL text.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';

const require = createRequire(import.meta.url);
let PGlite;
let dependencyError;
try {
  ({ PGlite } = require(process.env.PGLITE_PACKAGE || '@electric-sql/pglite'));
  if (typeof PGlite !== 'function') throw new TypeError('PGlite export missing.');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  dependencyError = error;
}
const options = {
  skip: !PGlite && `PGlite unavailable; set PGLITE_PACKAGE (${dependencyError?.code || 'load failed'}).`,
};
const sqlFile = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const sources = Object.fromEntries(await Promise.all([
  'migration_20260322_unified_commerce.sql',
  'migration_20260323_paid_system.sql',
  'migration_20260329_payment_verification.sql',
  'migration_20260401_order_proof_guard.sql',
  'migration_20260402_fix_duplicate_orders.sql',
  'migration_20260404_allow_rejected_resubmit.sql',
  'migration_20260509_membership_and_video_consistency.sql',
  'migration_20260914_training_prices.sql',
  'deploy/training-pricing-rollback.sql',
].map(async name => [name, await sqlFile(name)])));
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userId = uuid(701);
const otherUserId = uuid(702);
const adminId = uuid(799);
const prefixes = ['GLOM', 'ICU', 'TX', 'PATHO', 'DA'];
const productId = (prefix, variant = 'FULL') => uuid(prefixes.indexOf(prefix) * 3 + ({ BUNDLE: 1, FULL: 2, VIDEO: 3 })[variant]);
const projectId = prefix => uuid(100 + prefixes.indexOf(prefix));
const cohortId = prefix => uuid(300 + prefixes.indexOf(prefix));
const specialtyId = prefix => uuid(200 + prefixes.indexOf(prefix));
let db;

before(async () => {
  if (!PGlite) return;
  db = new PGlite();
  await db.waitReady;
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    alter default privileges grant all on tables to anon, authenticated, service_role;
    alter default privileges grant execute on functions to anon, authenticated, service_role;
  `);
});
beforeEach(async () => { if (db) await fixture(); });
after(async () => { if (db) await db.close(); });

async function fixture() {
  await db.exec('rollback');
  await db.exec(`
    reset role;
    drop schema if exists kidneysphere_release_private cascade;
    drop schema if exists public cascade;
    drop schema if exists auth cascade;
    drop schema if exists storage cascade;
    create schema public;
    create schema auth;
    create schema storage;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    create table public.profiles (
      id uuid primary key references auth.users(id), role text default 'user',
      full_name text, display_name text, email text, membership_status text,
      updated_at timestamptz default now()
    );
    alter table public.profiles enable row level security;
    create policy profiles_read_own on public.profiles for select using(id=auth.uid());
    create function public.is_admin() returns boolean language sql stable security definer
      set search_path = public as $$
      select exists(select 1 from public.profiles where id=auth.uid() and role='admin');
    $$;
    create table storage.buckets (id text primary key,name text,public boolean default false);
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
      name text not null, owner uuid, owner_id text, metadata jsonb,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      unique(bucket_id,name)
    );
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1];
    $$;
    create table public.learning_videos (
      id uuid primary key default gen_random_uuid(), title text, source text,
      membership_accessible boolean default false
    );
    create table public.training_programs (
      id bigint primary key,title text not null,product_code text,price_cny numeric(10,2),
      status text,link text,deleted_at timestamptz,
      created_at timestamptz default now(),updated_at timestamptz default now()
    );
  `);
  await db.exec(sources['migration_20260322_unified_commerce.sql']);
  // Execute the actual paid-system schema/RPC section, excluding seed catalog.
  await db.exec(sources['migration_20260323_paid_system.sql'].split('-- 6. SEED DATA')[0]);
  for (const name of [
    'migration_20260329_payment_verification.sql',
    'migration_20260401_order_proof_guard.sql',
    'migration_20260402_fix_duplicate_orders.sql',
    'migration_20260404_allow_rejected_resubmit.sql',
    'migration_20260509_membership_and_video_consistency.sql',
  ]) await db.exec(sources[name]);
  await db.exec(`
    alter table products add column early_bird_deadline timestamptz;
    insert into auth.users (id,email) values
      ('${userId}','student@example.test'),('${otherUserId}','other@example.test'),('${adminId}','admin@example.test');
    insert into profiles (id,role,full_name,email,membership_status)
      select id,case when id='${adminId}' then 'admin' else 'user' end,
        'Fixture User',email,'none' from auth.users;
    select set_config('request.jwt.claim.sub','',false);
  `);
  for (const [index,prefix] of prefixes.entries()) {
    const specialty = specialtyId(prefix);
    await db.query('insert into specialties(id,code,name) values ($1,$2,$3)', [specialty,prefix.toLowerCase(),`${prefix} specialty`]);
    for (const variant of ['BUNDLE','FULL','VIDEO']) {
      const sku = `${prefix}-${variant === 'BUNDLE' ? 'BUNDLE' : `REG-${variant}`}-2026`;
      const price = variant === 'FULL' ? 1280 : variant === 'BUNDLE' ? 980 : 780;
      await db.query(`insert into products(id,product_code,product_type,title,subtitle,description,
        price_cny,list_price_cny,duration_days,specialty_id,project_id,cohort_id,is_active,early_bird_deadline)
        values ($1,$2,$3,$4,'早鸟优惠','早鸟优惠',$5,$6,730,$7,$8,$9,true,'2026-05-30')`,
      [productId(prefix,variant),sku,variant === 'BUNDLE' ? 'specialty_bundle' : 'project_registration',
        `${prefix} ${variant}`,price,variant === 'FULL' ? 1580 : 1200,specialty,
        variant === 'FULL' ? projectId(prefix) : null,variant === 'FULL' ? cohortId(prefix) : null]);
      await db.query(`insert into product_price_versions (product_id,version_name,sale_price_cny,status)
        values ($1,'historical early offer',$2,'active')`, [productId(prefix,variant),price]);
      await db.query(`insert into training_programs(id,title,product_code,price_cny,status)
        values($1,$2,$3,$4,'recruiting')`,[index*3+({BUNDLE:1,FULL:2,VIDEO:3})[variant],sku,sku,price]);
    }
    await db.query(`insert into learning_projects(id,project_code,title,includes_bundle_product_id,
      registration_fee_cny,status,is_active) values($1,$2,$3,$4,1280,'recruiting',true)`,
    [projectId(prefix),`PROJ-${prefix}-2026`,`${prefix} training`,productId(prefix,'BUNDLE')]);
    await db.query(`insert into cohorts(id,project_id,cohort_code,title,status,group_required,group_qr_url)
      values($1,$2,$3,$4,'recruiting',true,$5)`,
    [cohortId(prefix),projectId(prefix),`COHORT-${prefix}-2026`,`${prefix} cohort`,`https://groups.example.test/${prefix}`]);
    await db.query('update specialties set bundle_product_id=$1 where id=$2',[productId(prefix,'BUNDLE'),specialty]);
  }
  await db.exec(`
    insert into products(id,product_code,product_type,title,price_cny,duration_days,is_active,video_id) values
      ('${uuid(900)}','MEMBERSHIP-YEARLY','membership_plan','Membership',299,365,true,null),
      ('${uuid(901)}','VIDEO-STANDALONE','single_video','Single video',50,30,true,'${uuid(902)}');
    insert into notification_templates(code,title,body) values ('order_approved','Order approved','Approved');
    insert into system_config(key,value) values
      ('specialty_bundle_early_price','980'),('specialty_bundle_regular_price','1200'),
      ('project_full_early_price','1280'),('project_full_regular_price','1580'),
      ('project_video_early_price','780'),('project_video_regular_price','980'),
      ('pricing_early_bird_deadline','2026-05-30');
  `);
}

async function rows(sql, values = []) { return (await db.query(sql,values)).rows; }
async function asUser(id, operation, role = 'authenticated') {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id || '']);
  await db.exec(`set role ${role}`);
  try { return await operation(); }
  finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
}
async function rpc(id,name,values = []) {
  return asUser(id, async () => {
    const [result] = await rows(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) as result`,values);
    return result.result;
  });
}
async function applyRelease() {
  await db.exec(sources['migration_20260914_training_prices.sql']);
  await db.exec(await sqlFile('migration_20260914_payment_enrollment.sql'));
}
async function createOrder(prefix='ICU',variant='FULL',owner=userId) {
  return rpc(owner,'create_order_with_items',[productId(prefix,variant),'wechat']);
}
async function proofObject(orderId,{owner=userId,suffix='proof',path}={}) {
  path ||= `${owner}/${orderId}/${suffix}.png`;
  await db.query(`insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
    values('payment_proofs',$1,$2::uuid,($2::uuid)::text,jsonb_build_object('mimetype','image/png','size',128))
    on conflict(bucket_id,name) do nothing`,[path,owner]);
  return path;
}
async function submitProof(order,{owner=userId,path,hash='a'.repeat(64),amount=order.total_amount_cny,...details}={}) {
  path ||= await proofObject(order.order_id,{owner});
  return rpc(owner,'submit_payment_proof',[order.order_id,'wechat',amount,path,hash,
    details.payer || 'Fixture Payer','1234','fixture_wechat','12345678901','student@example.test','Fixture receipt']);
}
async function review(orderId) { return rpc(adminId,'admin_get_order_fulfillment',[orderId]); }
async function approve(orderId,{received=true,fingerprint,note='Verified against receiving account'}={}) {
  fingerprint ??= (await review(orderId)).review_fingerprint;
  return rpc(adminId,'admin_approve_order_verified',[orderId,received,fingerprint,note]);
}
async function snapshot(tables) {
  const result = {};
  for (const table of tables) result[table] = await rows(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`);
  return result;
}
const commerceTables = ['orders','order_items','payment_proofs','user_entitlements','project_enrollments','audit_logs','notification_jobs'];
async function rejectedWithoutChanges(operation,pattern=/.+/) {
  const before = await snapshot(commerceTables);
  await assert.rejects(operation,pattern);
  assert.deepEqual(await snapshot(commerceTables),before,'rejected operation must leave all commerce records unchanged');
}

test('fixture loads actual baseline schema, policies, price/proof triggers and legacy RPCs',options,async()=>{
  assert.equal((await rows('select count(*)::int as n from products'))[0].n,17);
  assert.equal((await rows("select count(*)::int as n from pg_policies where schemaname='public'"))[0].n > 20,true);
  for (const name of ['trg_order_item_price_check','trg_order_total_sync','trg_proof_amount_check','trg_order_review_guard']) {
    assert.equal((await rows('select count(*)::int as n from pg_trigger where tgname=$1',[name]))[0].n,1);
  }
  const order = await createOrder();
  assert.equal(order.total_amount_cny,1280);
  assert.equal((await rows('select count(*)::int as n from order_items'))[0].n,1);
});

test('create_order reads regular server prices and safely reuses the original quoted order amount',options,async()=>{
  const original = await createOrder();
  await applyRelease();
  const history = await snapshot(['orders','order_items']);
  const reused = await createOrder();
  assert.equal(reused.order_id,original.order_id);
  assert.equal(Number(reused.total_amount_cny),1280,'reuse must display the stored payable amount, not today\'s catalog price');
  assert.deepEqual(await snapshot(['orders','order_items']),history);
  const current = await createOrder('GLOM');
  const bundle = await createOrder('TX','BUNDLE');
  assert.equal(Number(current.total_amount_cny),1580);
  assert.equal(Number(bundle.total_amount_cny),1200);
  await rejectedWithoutChanges(()=>createOrder('ICU','VIDEO'));
  await rejectedWithoutChanges(()=>rpc(null,'create_order_with_items',[productId('DA'),'wechat']));
});

test('retirement blocks create_order even when the user already has a legacy pending VIDEO order',options,async()=>{
  await createOrder('ICU','VIDEO');
  await applyRelease();
  await rejectedWithoutChanges(()=>createOrder('ICU','VIDEO'));
  await db.query('update products set is_active=false where id=$1',[productId('DA')]);
  await rejectedWithoutChanges(()=>createOrder('DA'));
});

test('submit_payment_proof atomically stores the exact amount and moves the owner order to review; exact retries do not duplicate it',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  const result = await submitProof(order);
  assert.equal(result.ok,true);
  assert.equal(result.status,'pending_review');
  assert.ok(result.proof_id);
  const [saved] = await rows('select * from orders where id=$1',[order.order_id]);
  assert.equal(saved.status,'pending_review');
  assert.equal(saved.contact_wechat,'fixture_wechat');
  assert.ok(saved.paid_at);
  const before = await snapshot(commerceTables);
  const repeated = await submitProof(order);
  assert.equal(repeated.proof_id,result.proof_id);
  assert.equal(repeated.reused,true);
  assert.deepEqual(await snapshot(commerceTables),before);
  const [proof] = await rows('select * from payment_proofs where id=$1',[result.proof_id]);
  assert.equal(proof.user_id,userId);
  assert.equal(Number(proof.amount_cny),1580);
  assert.equal(proof.proof_bucket,'payment_proofs');
});

test('proof submission rejects other users, false paths, foreign object ownership, mismatched amounts and invalid hashes without side effects',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  const legitimate = await proofObject(order.order_id);
  await rejectedWithoutChanges(()=>submitProof(order,{owner:otherUserId,path:legitimate}));
  await rejectedWithoutChanges(()=>submitProof(order,{path:`${userId}/${order.order_id}/missing.png`}));
  const foreignPath = await proofObject(order.order_id,{owner:otherUserId});
  await rejectedWithoutChanges(()=>submitProof(order,{path:foreignPath}));
  const wrongOwnerPath = await proofObject(order.order_id,{owner:otherUserId,path:`${userId}/${order.order_id}/foreign-owner.png`});
  await rejectedWithoutChanges(()=>submitProof(order,{path:wrongOwnerPath}));
  await rejectedWithoutChanges(()=>submitProof(order,{path:legitimate,amount:1}));
  await rejectedWithoutChanges(()=>submitProof(order,{path:legitimate,hash:'not-a-sha256'}));
});

test('a receipt hash or storage object cannot be reused across orders, including by another account',options,async()=>{
  await applyRelease();
  const first = await createOrder('ICU');
  await submitProof(first);
  const second = await createOrder('TX');
  const secondPath = await proofObject(second.order_id);
  await rejectedWithoutChanges(()=>submitProof(second,{path:secondPath}));
  await rejectedWithoutChanges(()=>submitProof(second,{path:`${userId}/${first.order_id}/proof.png`,hash:'b'.repeat(64)}));
  const third = await createOrder('GLOM','FULL',otherUserId);
  const thirdPath = await proofObject(third.order_id,{owner:otherUserId});
  await rejectedWithoutChanges(()=>submitProof(third,{owner:otherUserId,path:thirdPath}));
});

test('authenticated clients cannot forge commerce rows through table or explicit column grants',options,async()=>{
  // Supabase deployments may have pre-existing column grants in addition to
  // table grants. Both must be removed or a REST write can bypass the RPC.
  await db.exec(`grant insert(order_id,user_id,channel,amount_cny,proof_bucket,proof_path) on payment_proofs to authenticated;
    grant insert(user_id,project_id,cohort_id,source_order_id,enrollment_status,approval_status) on project_enrollments to authenticated;
    grant update(status) on orders to authenticated;`);
  await applyRelease();
  const order = await createOrder();
  const path = await proofObject(order.order_id);
  await rejectedWithoutChanges(()=>asUser(userId,()=>db.query(`insert into payment_proofs
    (order_id,user_id,channel,amount_cny,proof_bucket,proof_path)
    values($1,$2,'wechat',1580,'payment_proofs',$3)`,[order.order_id,userId,path])),/permission denied/);
  await rejectedWithoutChanges(()=>asUser(userId,()=>db.query(`insert into project_enrollments
    (user_id,project_id,cohort_id,source_order_id,enrollment_status,approval_status)
    values($1,$2,$3,$4,'confirmed','approved')`,[userId,projectId('ICU'),cohortId('ICU'),order.order_id])),/permission denied/);
  await rejectedWithoutChanges(()=>asUser(userId,()=>db.query("update orders set status='cancelled' where id=$1",[order.order_id])),/permission denied/);
});

test('approval requires an administrator, explicit received-payment confirmation and the reviewed fingerprint',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  await submitProof(order);
  const preview = await review(order.order_id);
  assert.ok(preview.review_fingerprint);
  assert.ok(Array.isArray(preview.items));
  assert.equal(preview.items.length,1);
  await rejectedWithoutChanges(()=>rpc(userId,'admin_get_order_fulfillment',[order.order_id]));
  await rejectedWithoutChanges(()=>rpc(userId,'admin_approve_order_verified',[order.order_id,true,preview.review_fingerprint,'forged admin']));
  await rejectedWithoutChanges(()=>approve(order.order_id,{received:false,fingerprint:preview.review_fingerprint}));
  await rejectedWithoutChanges(()=>approve(order.order_id,{fingerprint:'stale-or-forged-fingerprint'}));
  await rejectedWithoutChanges(()=>rpc(adminId,'admin_approve_order',[order.order_id,'legacy shortcut']));
  assert.equal((await approve(order.order_id,{fingerprint:preview.review_fingerprint})).ok,true);
});

test('FULL approval grants exactly one confirmed project enrollment and retry cannot extend or duplicate rights',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  await submitProof(order);
  const first = await approve(order.order_id);
  assert.equal(first.ok,true);
  const enrollments = await rows('select * from project_enrollments where source_order_id=$1',[order.order_id]);
  assert.equal(enrollments.length,1);
  assert.equal(enrollments[0].project_id,projectId('ICU'));
  assert.equal(enrollments[0].cohort_id,cohortId('ICU'));
  assert.equal(enrollments[0].approval_status,'approved');
  assert.equal(enrollments[0].enrollment_status,'confirmed');
  const entitlements = await rows('select * from user_entitlements where source_order_id=$1',[order.order_id]);
  assert.equal(entitlements.filter(e=>e.entitlement_type==='project_access').length,1);
  const before = await snapshot(commerceTables);
  const second = await approve(order.order_id);
  assert.equal(second.ok,true);
  assert.equal(second.already_approved,true);
  assert.deepEqual(await snapshot(commerceTables),before,'retry must preserve every end_at and all proof/audit/enrollment rows');
});

test('BUNDLE grants replay rights without a project enrollment or group entry',options,async()=>{
  await applyRelease();
  const order = await createOrder('ICU','BUNDLE');
  await submitProof(order);
  await approve(order.order_id);
  const rights = await rows('select entitlement_type from user_entitlements where source_order_id=$1',[order.order_id]);
  assert.equal(rights.filter(e=>e.entitlement_type==='specialty_bundle').length,1);
  assert.equal(rights.filter(e=>e.entitlement_type==='project_access').length,0);
  assert.equal((await rows('select count(*)::int n from project_enrollments where source_order_id=$1',[order.order_id]))[0].n,0);
  assert.equal((await asUser(userId,()=>rows('select * from get_my_enrollments()'))).length,0);
});

test('legacy pending VIDEO approval preserves replay scope and cannot upgrade it into FULL enrollment',options,async()=>{
  const order = await createOrder('ICU','VIDEO');
  await applyRelease();
  await submitProof(order);
  await approve(order.order_id);
  assert.equal((await rows('select count(*)::int n from project_enrollments where source_order_id=$1',[order.order_id]))[0].n,0);
  const rights = await rows('select * from user_entitlements where source_order_id=$1',[order.order_id]);
  assert.ok(rights.length > 0,'legacy paid replay retains its existing product scope');
  const repairBefore = await snapshot(commerceTables);
  try { await rpc(adminId,'admin_repair_order_enrollment',[order.order_id,'must not upgrade replay']); }
  catch (error) { assert.ok(error.message); }
  assert.deepEqual(await snapshot(commerceTables),repairBefore);
});

for (const [label,corrupt] of [
  ['order total differs from item sum',async order=>db.query('update orders set total_amount_cny=1600 where id=$1',[order.order_id])],
  ['stored object was removed',async order=>db.query('delete from storage.objects where name=$1',[`${userId}/${order.order_id}/proof.png`])],
  ['proof path was forged',async order=>{
    // Represent a legacy/imported bad row that predates the new proof trigger.
    await db.exec('alter table payment_proofs disable trigger trg_proof_amount_check');
    await db.query("update payment_proofs set proof_path='fake/not-an-object.png' where order_id=$1",[order.order_id]);
    await db.exec('alter table payment_proofs enable trigger trg_proof_amount_check');
  }],
]) {
  test(`verified approval refuses ${label} atomically`,options,async()=>{
    await applyRelease();
    const order = await createOrder();
    await submitProof(order);
    await corrupt(order);
    await rejectedWithoutChanges(()=>approve(order.order_id));
    assert.equal((await rows('select status from orders where id=$1',[order.order_id]))[0].status,'pending_review');
  });
}

test('order fulfillment remains frozen when the product is later rebound to another project, cohort or duration',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  await submitProof(order);
  const preview = await review(order.order_id);
  await db.query('update products set project_id=$1,cohort_id=$2,duration_days=7 where id=$3',
    [projectId('TX'),cohortId('TX'),productId('ICU')]);
  const subsequent = await review(order.order_id);
  assert.equal(subsequent.review_fingerprint,preview.review_fingerprint,'current product edits cannot rewrite the frozen contract');
  await approve(order.order_id,{fingerprint:preview.review_fingerprint});
  const [enrollment] = await rows('select * from project_enrollments where source_order_id=$1',[order.order_id]);
  assert.equal(enrollment.project_id,projectId('ICU'));
  assert.equal(enrollment.cohort_id,cohortId('ICU'));
  const [right] = await rows("select project_id,extract(epoch from (end_at-start_at))/86400 as days from user_entitlements where source_order_id=$1 and entitlement_type='project_access'",[order.order_id]);
  assert.equal(right.project_id,projectId('ICU'));
  assert.equal(Number(right.days),730);
});

test('project/cohort confusion at order creation is rejected instead of granting another project',options,async()=>{
  await applyRelease();
  await db.query('update products set project_id=$1,cohort_id=$2 where id=$3',[projectId('TX'),cohortId('TX'),productId('ICU')]);
  await rejectedWithoutChanges(()=>createOrder('ICU'));
});

async function historicalFull({status='active',expired=false,orderStatus='approved',nullProject=false}={}) {
  // Older approvals did not freeze a cohort; do not infer one during repair.
  await db.query('update products set cohort_id=null,project_id=$1 where id=$2',[nullProject?null:projectId('ICU'),productId('ICU')]);
  const order = await createOrder('ICU');
  await db.query(`update orders set status=$1,approved_at='2026-04-01',approved_by=$2 where id=$3`,[orderStatus,adminId,order.order_id]);
  const entitlementId = uuid(850);
  await db.query(`insert into user_entitlements(id,user_id,entitlement_type,source_order_id,source_product_id,
    project_id,specialty_id,start_at,end_at,status,grant_reason)
    values($1,$2,'project_access',$3,$4,$5,$6,'2026-04-01',$7,$8,'Historical training entitlement')`,
  [entitlementId,userId,order.order_id,productId('ICU'),nullProject?null:projectId('ICU'),specialtyId('ICU'),
    expired?'2026-04-02':'2028-04-01',status]);
  return {...order,entitlementId};
}

test('historical FULL enrollment repair preserves original rights dates and is idempotent',options,async()=>{
  const order = await historicalFull({nullProject:true});
  const [beforeRight] = await rows('select * from user_entitlements where id=$1',[order.entitlementId]);
  await applyRelease();
  const repaired = await rpc(adminId,'admin_repair_order_enrollment',[order.order_id,'Verified historical full-training purchase']);
  assert.equal(repaired.ok,true);
  const [right] = await rows('select * from user_entitlements where id=$1',[order.entitlementId]);
  assert.equal(right.project_id,projectId('ICU'));
  assert.equal(right.start_at.toISOString(),beforeRight.start_at.toISOString());
  assert.equal(right.end_at.toISOString(),beforeRight.end_at.toISOString());
  assert.equal((await rows('select count(*)::int n from project_enrollments where source_order_id=$1',[order.order_id]))[0].n,1);
  const snapshotBefore = await snapshot(commerceTables);
  const retry = await rpc(adminId,'admin_repair_order_enrollment',[order.order_id,'retry']);
  assert.equal(retry.ok,true);
  assert.equal(retry.already_complete,true);
  assert.deepEqual(await snapshot(commerceTables),snapshotBefore);
});

for (const [label,historyOptions] of [
  ['revoked rights',{status:'revoked'}],
  ['expired entitlement status',{status:'expired'}],
  ['elapsed end_at',{expired:true}],
  ['refunded order',{orderStatus:'refunded'}],
  ['cancelled order',{orderStatus:'cancelled'}],
]) {
  test(`historical enrollment repair refuses ${label} without restoring access`,options,async()=>{
    const order = await historicalFull(historyOptions);
    await applyRelease();
    await rejectedWithoutChanges(()=>rpc(adminId,'admin_repair_order_enrollment',[order.order_id,'must remain blocked']));
    assert.equal((await rows('select count(*)::int n from project_enrollments where source_order_id=$1',[order.order_id]))[0].n,0);
  });
}

test('cohort QR data is inaccessible through public table reads and exposed only for an eligible FULL enrollment',options,async()=>{
  await applyRelease();
  for (const id of [null,userId,otherUserId]) {
    await assert.rejects(asUser(id,()=>rows('select group_qr_url from cohorts'),id?'authenticated':'anon'),/permission denied/);
  }
  await assert.rejects(rpc(userId,'admin_get_cohorts',[projectId('ICU')]),/.+/);
  const adminCohorts = await rpc(adminId,'admin_get_cohorts',[projectId('ICU')]);
  assert.ok(JSON.stringify(adminCohorts).includes('https://groups.example.test/ICU'));
  const order = await createOrder();
  await submitProof(order);
  await approve(order.order_id);
  const learning = await asUser(userId,()=>rows('select * from get_my_enrollments()'));
  assert.equal(learning.length,1);
  assert.equal(learning[0].group_qr_url,'https://groups.example.test/ICU');
  assert.equal((await asUser(otherUserId,()=>rows('select * from get_my_enrollments()'))).length,0);
  await db.query("update user_entitlements set status='revoked' where source_order_id=$1",[order.order_id]);
  const revoked = await asUser(userId,()=>rows('select * from get_my_enrollments()'));
  assert.ok(revoked.every(row=>!row.group_qr_url),'revocation removes access to a group QR even if enrollment rows remain');
});

async function publicFunctionSnapshot() {
  return rows(`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,
    (select jsonb_agg(a::text order by a::text) from unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a) as acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' order by signature`);
}
async function tablePrivileges() {
  return rows(`select table_name,grantee,privilege_type,is_grantable from information_schema.table_privileges
    where table_schema='public' order by table_name,grantee,privilege_type,is_grantable`);
}
async function columnPrivileges() {
  return rows(`select table_name,column_name,grantee,privilege_type,is_grantable
    from information_schema.column_privileges where table_schema='public'
    order by table_name,column_name,grantee,privilege_type,is_grantable`);
}
async function rejectSqlTransaction(sql,pattern=/.+/) {
  await assert.rejects(db.exec(sql),pattern);
  await db.exec('rollback');
}

test('payment release rerun preserves first backups and rollback restores original function definitions and privileges',options,async()=>{
  await db.exec('grant update(notes) on project_enrollments to authenticated with grant option');
  const functionsBefore = await publicFunctionSnapshot();
  const privilegesBefore = await tablePrivileges();
  const columnsBefore = await columnPrivileges();
  await applyRelease();
  const backups = await snapshot([
    'kidneysphere_release_private.payment_function_backups',
    'kidneysphere_release_private.payment_table_backups',
    'kidneysphere_release_private.payment_catalog_backups',
  ]);
  const applied = await publicFunctionSnapshot();
  await db.exec(await sqlFile('migration_20260914_payment_enrollment.sql'));
  assert.deepEqual(await publicFunctionSnapshot(),applied);
  assert.deepEqual(await snapshot(Object.keys(backups)),backups);
  await db.exec(await sqlFile('deploy/payment-enrollment-rollback.sql'));
  assert.deepEqual(await publicFunctionSnapshot(),functionsBefore);
  assert.deepEqual(await tablePrivileges(),privilegesBefore);
  assert.deepEqual(await columnPrivileges(),columnsBefore);
  const afterRollback = await publicFunctionSnapshot();
  await db.exec(await sqlFile('deploy/payment-enrollment-rollback.sql'));
  assert.deepEqual(await publicFunctionSnapshot(),afterRollback);
  await db.exec(sources['deploy/training-pricing-rollback.sql']);
  assert.equal(Number((await rows('select price_cny from products where id=$1',[productId('ICU')]))[0].price_cny),1280);
});

test('payment rollback detects later function edits and does not partially restore the release',options,async()=>{
  await applyRelease();
  await db.exec(`create or replace function public.create_order_with_items(p_product_id uuid,p_channel text default 'wechat')
    returns jsonb language plpgsql security definer set search_path=public as $$
    begin return jsonb_build_object('changed_by_later_release',true); end; $$;`);
  const functionsBefore = await publicFunctionSnapshot();
  const privilegesBefore = await tablePrivileges();
  await rejectSqlTransaction(await sqlFile('deploy/payment-enrollment-rollback.sql'));
  assert.deepEqual(await publicFunctionSnapshot(),functionsBefore);
  assert.deepEqual(await tablePrivileges(),privilegesBefore);
});

test('API roles cannot read payment backups or execute private repair/restoration functions',options,async()=>{
  await applyRelease();
  for (const role of ['anon','authenticated','service_role']) {
    for (const table of ['payment_function_backups','payment_table_backups','payment_catalog_backups','payment_item_snapshots']) {
      const [privilege] = await rows('select has_table_privilege($1,$2,\'SELECT\') as permitted',[role,`kidneysphere_release_private.${table}`]);
      assert.equal(privilege.permitted,false,`${role} must not read ${table}`);
    }
    const [privilege] = await rows("select has_function_privilege($1,'kidneysphere_release_private.restore_payment_enrollment_20260914()','EXECUTE') as permitted",[role]);
    assert.equal(privilege.permitted,false);
    await assert.rejects(asUser(null,()=>rows('select * from kidneysphere_release_private.payment_item_snapshots'),role),/permission denied/);
  }
});

test('a storage object changed after review invalidates the fingerprint and requires a fresh review',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  await submitProof(order);
  const old = await review(order.order_id);
  await db.query("update storage.objects set updated_at=updated_at+interval '1 second' where name=$1",[`${userId}/${order.order_id}/proof.png`]);
  const fresh = await review(order.order_id);
  assert.notEqual(fresh.review_fingerprint,old.review_fingerprint);
  await rejectedWithoutChanges(()=>approve(order.order_id,{fingerprint:old.review_fingerprint}));
  assert.equal((await approve(order.order_id,{fingerprint:fresh.review_fingerprint})).ok,true);
});

test('payment release preflight refuses a VIDEO product bound to a training project and rolls back its own changes',options,async()=>{
  await db.exec(sources['migration_20260914_training_prices.sql']);
  await db.query('update products set project_id=$1 where id=$2',[projectId('ICU'),productId('ICU','VIDEO')]);
  const original = await snapshot(['products',...commerceTables]);
  const functionsBefore = await publicFunctionSnapshot();
  await rejectSqlTransaction(await sqlFile('migration_20260914_payment_enrollment.sql'),/PAYMENT_RELEASE_BLOCKED/);
  assert.deepEqual(await snapshot(['products',...commerceTables]),original);
  assert.deepEqual(await publicFunctionSnapshot(),functionsBefore);
});

function combinedSql() {
  // Execute the production builder's real composition routine; do not emulate
  // its transaction stripping or conditional rollback journal in this test.
  const script = `import json,runpy,sys\nfrom pathlib import Path\nroot=Path(sys.argv[1])\nm=runpy.run_path(str(root/'deploy/build-payment-training-release.py'))\nsources={name:(root/name).read_bytes() for name in m['SQL_FILES']}\nprint(json.dumps({key:value.decode('utf8') for key,value in m['combined_sql'](sources).items()}))`;
  return JSON.parse(execFileSync('python',['-c',script,fileURLToPath(new URL('..',import.meta.url))],{encoding:'utf8'}));
}
const catalogTables = ['products','product_price_versions','learning_projects','training_programs','system_config'];
async function catalogBusinessSnapshot() {
  const result = {};
  for (const table of catalogTables) result[table] = await rows(`select to_jsonb(t)-'updated_at' as row from ${table} t order by to_jsonb(t)::text`);
  return result;
}

test('real combined SQL applies and rolls back pricing plus payment together on an untouched baseline',options,async()=>{
  const combined = combinedSql();
  const before = await catalogBusinessSnapshot();
  const functionsBefore = await publicFunctionSnapshot();
  await db.exec(combined['.sql']);
  const version = await rpc(userId,'get_payment_enrollment_release');
  assert.equal(version.payment_state,'applied');
  assert.equal(version.pricing_state,'applied');
  assert.equal(Number((await createOrder()).total_amount_cny),1580);
  await db.exec(combined['.inspect.sql']);
  const newOrderHistory = await snapshot(commerceTables);
  await db.exec(combined['.rollback.sql']);
  assert.deepEqual(await catalogBusinessSnapshot(),before);
  assert.deepEqual(await publicFunctionSnapshot(),functionsBefore);
  assert.deepEqual(await snapshot(commerceTables),newOrderHistory,'rollback must preserve orders created while the release was active');
  await db.exec(combined['.sql']);
  assert.equal((await rpc(userId,'get_payment_enrollment_release')).payment_state,'applied');
});

test('combined rollback preserves pricing that was already applied before the combined payment release',options,async()=>{
  await db.exec(sources['migration_20260914_training_prices.sql']);
  const priced = await catalogBusinessSnapshot();
  const combined = combinedSql();
  await db.exec(combined['.sql']);
  await db.exec(combined['.rollback.sql']);
  assert.deepEqual(await catalogBusinessSnapshot(),priced);
  const [priceRelease] = await rows('select state from kidneysphere_release_private.training_price_releases');
  const [paymentRelease] = await rows('select state from kidneysphere_release_private.payment_enrollment_releases');
  assert.equal(priceRelease.state,'applied');
  assert.equal(paymentRelease.state,'rolled_back');
});

test('a payment preflight failure rolls back the earlier pricing changes within the real combined transaction',options,async()=>{
  const combined = combinedSql();
  // Pricing does not depend on specialty codes; payment's exact manifest does.
  await db.exec("update specialties set code='unexpected-icu' where code='icu'");
  const before = await snapshot([...catalogTables,...commerceTables]);
  const functionsBefore = await publicFunctionSnapshot();
  await rejectSqlTransaction(combined['.sql'],/PAYMENT_RELEASE_BLOCKED/);
  assert.deepEqual(await snapshot([...catalogTables,...commerceTables]),before);
  assert.deepEqual(await publicFunctionSnapshot(),functionsBefore);
  assert.equal((await rows("select to_regnamespace('kidneysphere_release_private') as schema"))[0].schema,null);
});

test('mutating payment RPCs share a user advisory lock before locking an order (static ordering; no concurrent-race claim)',options,async()=>{
  await applyRelease();
  for (const signature of [
    'public.create_order_with_items(uuid,text)',
    'public.submit_order_for_review(uuid,text,text,text)',
    'public.submit_payment_proof(uuid,text,numeric,text,text,text,text,text,text,text,text)',
    'public.admin_approve_order_verified(uuid,boolean,text,text)',
    'public.admin_repair_order_enrollment(uuid,text)',
    'kidneysphere_release_private.payment_revoke_order(uuid,text,text)',
  ]) {
    const [{definition}] = await rows('select pg_get_functiondef($1::regprocedure) as definition',[signature]);
    const userLock = definition.indexOf("pg_advisory_xact_lock(hashtextextended('ks-payment-user:'");
    assert.ok(userLock>=0,`${signature} must use the shared user lock namespace`);
    const orderLock = /(?:from\s+public\.orders\b)[\s\S]*?for\s+update/i.exec(definition.slice(userLock));
    assert.ok(orderLock,`${signature} must lock its order after the user lock`);
  }
});

test('failure after proof insertion rolls back both the receipt and review transition, allowing a clean retry',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  const path = await proofObject(order.order_id);
  await db.exec(`create function public.test_abort_review() returns trigger language plpgsql as $$
    begin if new.status='pending_review' then raise exception 'INJECTED_REVIEW_FAILURE'; end if; return new; end; $$;
    create trigger test_abort_review before update on orders for each row execute function public.test_abort_review();`);
  await rejectedWithoutChanges(()=>submitProof(order,{path}),/INJECTED_REVIEW_FAILURE/);
  await db.exec('drop trigger test_abort_review on orders; drop function public.test_abort_review()');
  assert.equal((await submitProof(order,{path})).ok,true);
  assert.equal((await rows('select count(*)::int n from payment_proofs where order_id=$1',[order.order_id]))[0].n,1);
});

test('each FULL order keeps its own gifted membership when another longer training order is revoked',options,async()=>{
  await applyRelease();
  await db.query('update products set duration_days=1200 where id=$1',[productId('ICU')]);
  const long = await createOrder('ICU');
  await submitProof(long,{hash:'c'.repeat(64)});
  await approve(long.order_id);
  const shorter = await createOrder('TX');
  await submitProof(shorter,{hash:'d'.repeat(64)});
  await approve(shorter.order_id);
  const [gift] = await rows("select * from user_entitlements where source_order_id=$1 and entitlement_type='membership'",[shorter.order_id]);
  assert.ok(gift,'the later order must own an independent gift even while a longer membership exists');
  assert.equal((gift.end_at-gift.start_at)/86400000,730);
  const shorterBefore = await rows('select to_jsonb(t) as row from user_entitlements t where source_order_id=$1 order by id',[shorter.order_id]);
  assert.equal((await rpc(adminId,'admin_revoke_order_approval',[long.order_id,'Reversing the other payment'])).ok,true);
  assert.deepEqual(await rows('select to_jsonb(t) as row from user_entitlements t where source_order_id=$1 order by id',[shorter.order_id]),shorterBefore);
  assert.equal((await rows('select membership_status from profiles where id=$1',[userId]))[0].membership_status,'member');
  assert.equal((await rows("select count(*)::int n from user_entitlements where source_order_id=$1 and status='active'",[long.order_id]))[0].n,0);
});

test('rejecting an approved order revokes access and enrollment; a later proof cannot silently resurrect the cancelled history',options,async()=>{
  await applyRelease();
  const order = await createOrder();
  await submitProof(order);
  await approve(order.order_id);
  assert.equal((await rpc(adminId,'admin_reject_order',[order.order_id,'Payment was reversed'])).ok,true);
  assert.equal((await rows("select count(*)::int n from user_entitlements where source_order_id=$1 and status='active'",[order.order_id]))[0].n,0);
  const [enrollment] = await rows('select * from project_enrollments where source_order_id=$1',[order.order_id]);
  assert.equal(enrollment.enrollment_status,'cancelled');
  const learning = await rpc(userId,'get_my_learning_enrollments');
  assert.ok(learning.every(row=>!row.group_qr_url && !row.is_access_active));
  await rejectedWithoutChanges(()=>rpc(adminId,'admin_repair_order_enrollment',[order.order_id,'must not revive']));
  const path = await proofObject(order.order_id,{suffix:'resubmitted'});
  await submitProof(order,{path,hash:'e'.repeat(64)});
  await rejectedWithoutChanges(()=>approve(order.order_id));
});

test('payment rollback refuses a later privilege edit without partially restoring any functions or grants',options,async()=>{
  await applyRelease();
  await db.exec('grant update(notes) on project_enrollments to authenticated');
  const functionsBefore = await publicFunctionSnapshot();
  const privilegesBefore = await tablePrivileges();
  const columnsBefore = await rows(`select table_name,column_name,grantee,privilege_type,is_grantable
    from information_schema.column_privileges where table_schema='public'
    order by table_name,column_name,grantee,privilege_type,is_grantable`);
  await rejectSqlTransaction(await sqlFile('deploy/payment-enrollment-rollback.sql'),/PAYMENT_(?:RELEASE|ROLLBACK)_CONFLICT/);
  assert.deepEqual(await publicFunctionSnapshot(),functionsBefore);
  assert.deepEqual(await tablePrivileges(),privilegesBefore);
  assert.deepEqual(await rows(`select table_name,column_name,grantee,privilege_type,is_grantable
    from information_schema.column_privileges where table_schema='public'
    order by table_name,column_name,grantee,privilege_type,is_grantable`),columnsBefore);
});

test('a pending order item changed to a different project product cannot pass the frozen fulfillment review',options,async()=>{
  await applyRelease();
  const order = await createOrder('ICU');
  await submitProof(order);
  await db.query('update order_items set product_id=$1 where order_id=$2',[productId('TX'),order.order_id]);
  const preview = await review(order.order_id);
  assert.equal(preview.mapping_status,'blocked');
  await rejectedWithoutChanges(()=>approve(order.order_id,{fingerprint:preview.review_fingerprint}));
});

test('moving the referenced cohort to another project blocks review and approval of an existing frozen order',options,async()=>{
  await applyRelease();
  const order = await createOrder('ICU');
  await submitProof(order);
  const before = await review(order.order_id);
  assert.equal(before.mapping_status,'ready');
  await db.query('update cohorts set project_id=$1 where id=$2',[projectId('TX'),cohortId('ICU')]);
  const changed = await review(order.order_id);
  assert.equal(changed.mapping_status,'blocked');
  assert.ok(changed.blockers.length>0);
  await rejectedWithoutChanges(()=>approve(order.order_id,{fingerprint:before.review_fingerprint}));
  await rejectedWithoutChanges(()=>approve(order.order_id,{fingerprint:changed.review_fingerprint}));
});

async function insertStudyGroup() {
  await db.query(`insert into study_groups(id,project_id,cohort_id,name,qr_url,qr_backup_url)
    values($1,$2,$3,'ICU private study group',$4,$5)`,
  [uuid(880),projectId('ICU'),cohortId('ICU'),'https://groups.example.test/private-study-group','https://groups.example.test/private-study-group-backup']);
}

test('study-group QR and backup cannot be read through public table access; the administrator RPC remains available',options,async()=>{
  await insertStudyGroup();
  await applyRelease();
  for (const [id,role] of [[null,'anon'],[userId,'authenticated']]) {
    await assert.rejects(asUser(id,()=>rows('select qr_url,qr_backup_url from study_groups'),role),/permission denied/);
    const publicInfo = await asUser(id,()=>rows('select id,name from study_groups'),role);
    assert.equal(publicInfo.length,1,'safe public group fields remain readable');
  }
  await assert.rejects(rpc(userId,'admin_get_study_groups'),/Forbidden/);
  const group = await rpc(adminId,'admin_get_study_groups');
  assert.ok(JSON.stringify(group).includes('https://groups.example.test/private-study-group'));
  assert.ok(JSON.stringify(group).includes('https://groups.example.test/private-study-group-backup'));
});

test('study-group table and explicit QR column grants are restored exactly by rollback',options,async()=>{
  await insertStudyGroup();
  await db.exec('grant select(qr_url,qr_backup_url) on study_groups to authenticated with grant option; grant select(qr_url) on study_groups to anon');
  const tablesBefore = (await tablePrivileges()).filter(row=>row.table_name==='study_groups');
  const columnsBefore = (await columnPrivileges()).filter(row=>row.table_name==='study_groups');
  await applyRelease();
  await assert.rejects(asUser(userId,()=>rows('select qr_url from study_groups')),/permission denied/);
  await db.exec(await sqlFile('deploy/payment-enrollment-rollback.sql'));
  assert.deepEqual((await tablePrivileges()).filter(row=>row.table_name==='study_groups'),tablesBefore);
  assert.deepEqual((await columnPrivileges()).filter(row=>row.table_name==='study_groups'),columnsBefore);
  const restored = await asUser(userId,()=>rows('select qr_url,qr_backup_url from study_groups'));
  assert.equal(restored[0].qr_url,'https://groups.example.test/private-study-group');
  assert.equal(restored[0].qr_backup_url,'https://groups.example.test/private-study-group-backup');
  assert.equal((await rows("select to_regprocedure('public.admin_get_study_groups()') as fn"))[0].fn,null);
});

async function installLegacyBatchGrant() {
  const legacy = await sqlFile('migration_20260331_fix_project_access_specialty.sql');
  const start = legacy.indexOf('create or replace function public.admin_batch_grant_project(');
  assert.ok(start>=0,'the checked-in legacy batch-grant RPC must be present');
  // Keep the exact existing function and its permission statements, without
  // running unrelated historical video-access data updates in this fixture.
  await db.exec(legacy.slice(start));
}

test('the existing admin batch-grant RPC keeps legitimate manual project enrollment visible without changing its access dates',options,async()=>{
  await installLegacyBatchGrant();
  const granted = await rpc(adminId,'admin_batch_grant_project',[['student@example.test'],'PROJ-ICU-2026','Existing manual training grant']);
  assert.equal(granted.granted,1);
  const [original] = await rows("select * from user_entitlements where user_id=$1 and entitlement_type='project_access'",[userId]);
  assert.equal(original.source_order_id,null);
  await applyRelease();
  const beforeRead = await snapshot(commerceTables);
  const learning = await rpc(userId,'get_my_learning_enrollments');
  assert.equal(learning.length,1);
  assert.equal(learning[0].project_id,projectId('ICU'));
  assert.equal(learning[0].source_order_id,null);
  assert.equal(learning[0].is_access_active,true);
  assert.equal(new Date(learning[0].access_start_at).toISOString(),original.start_at.toISOString());
  assert.equal(new Date(learning[0].access_end_at).toISOString(),original.end_at.toISOString());
  assert.equal(learning[0].group_qr_url,null,'the legacy RPC did not assign a cohort');
  assert.deepEqual(await snapshot(commerceTables),beforeRead,'showing existing access must not grant or extend anything');
  const afterRelease = await rpc(adminId,'admin_batch_grant_project',[['other@example.test'],'PROJ-ICU-2026','Manual grant after release']);
  assert.equal(afterRelease.granted,1,'the unchanged administrator RPC remains usable after permission hardening');
  assert.equal((await rpc(otherUserId,'get_my_learning_enrollments'))[0].is_access_active,true);
});

test('manual enrollment cannot borrow access from another user, paid order, project or cohort',options,async()=>{
  await applyRelease();
  await db.query(`insert into project_enrollments(user_id,project_id,enrollment_status,approval_status)
    values($1,$2,'confirmed','approved')`,[userId,projectId('ICU')]);
  const paidOrder = await createOrder('ICU');
  await db.query("update orders set status='approved',approved_at=now() where id=$1",[paidOrder.order_id]);
  await db.query(`insert into user_entitlements(user_id,entitlement_type,source_order_id,source_product_id,
    project_id,cohort_id,specialty_id,status,start_at,end_at)
    values
    ($1,'project_access',null,$4,$5,null,$6,'active',now(),now()+interval '365 days'),
    ($2,'project_access',$3,$4,$5,null,$6,'active',now(),now()+interval '365 days'),
    ($2,'project_access',null,$4,$5,$7,$6,'active',now(),now()+interval '365 days'),
    ($2,'project_access',null,$8,$9,null,$10,'active',now(),now()+interval '365 days')`,
  [otherUserId,userId,paidOrder.order_id,productId('ICU'),projectId('ICU'),specialtyId('ICU'),cohortId('ICU'),productId('TX'),projectId('TX'),specialtyId('TX')]);
  const before = await snapshot(commerceTables);
  const learning = await rpc(userId,'get_my_learning_enrollments');
  assert.equal(learning.length,1);
  assert.equal(learning[0].source_order_id,null);
  assert.equal(learning[0].is_access_active,false);
  assert.equal(learning[0].group_qr_url,null);
  assert.equal(learning[0].access_end_at,null);
  assert.deepEqual(await snapshot(commerceTables),before);
});
