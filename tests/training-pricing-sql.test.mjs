/**
 * Execute the actual pricing migration and rollback in isolated PostgreSQL
 * (PGlite). No connection string, Supabase client or production data is used.
 *
 * Run with an installed @electric-sql/pglite package, or:
 * PGLITE_PACKAGE=/absolute/path/to/@electric-sql/pglite \
 *   node --test tests/training-pricing-sql.test.mjs
 *
 * Missing PGlite is an explicit skip, never a simulated SQL pass.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, beforeEach, test } from 'node:test';

const require = createRequire(import.meta.url);
let PGlite;
let dependencyError;
try {
  ({ PGlite } = require(process.env.PGLITE_PACKAGE || '@electric-sql/pglite'));
  if (typeof PGlite !== 'function') throw new TypeError('The supplied PGlite package does not export PGlite.');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  dependencyError = error;
}
const options = {
  skip: !PGlite && `PGlite unavailable; set PGLITE_PACKAGE to its installed package (${dependencyError?.code || 'load failed'}).`,
};
const migration = await readFile(new URL('../migration_20260914_training_prices.sql', import.meta.url), 'utf8');
const rollback = await readFile(new URL('../deploy/training-pricing-rollback.sql', import.meta.url), 'utf8');
const prefixes = ['GLOM', 'ICU', 'TX', 'PATHO', 'DA'];
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const catalogTables = ['products', 'product_price_versions', 'training_programs', 'learning_projects', 'system_config'];
const historyTables = ['orders', 'order_items', 'user_entitlements'];
const oldTime = '2026-03-23T00:00:00.000Z';
let db;

const schema = `
  create table public.products (
    id uuid primary key, product_code text unique not null, product_type text not null,
    title text not null, subtitle text, description text,
    price_cny numeric(10,2) not null, list_price_cny numeric(10,2),
    early_bird_deadline timestamptz, duration_days integer, specialty_id uuid,
    project_id uuid, cohort_id uuid, video_id uuid, includes_product_ids uuid[],
    is_active boolean not null, requires_review boolean not null default true,
    created_at timestamptz not null default '${oldTime}',
    updated_at timestamptz not null default '${oldTime}'
  );
  create table public.product_price_versions (
    id uuid primary key, product_id uuid not null references public.products(id),
    version_name text, list_price_cny numeric(10,2), sale_price_cny numeric(10,2) not null,
    effective_start_at timestamptz not null, effective_end_at timestamptz,
    status text not null, created_by uuid,
    created_at timestamptz not null default '${oldTime}'
  );
  create table public.learning_projects (
    id uuid primary key, project_code text unique not null, title text not null,
    registration_fee_cny numeric(10,2), status text not null, is_active boolean not null,
    includes_bundle_product_id uuid, requires_review boolean not null default true,
    created_at timestamptz not null default '${oldTime}',
    updated_at timestamptz not null default '${oldTime}'
  );
  create table public.training_programs (
    id bigint primary key, title text not null, product_code text,
    price_cny numeric(10,2), status text, link text, deleted_at timestamptz,
    created_at timestamptz not null default '${oldTime}',
    updated_at timestamptz not null default '${oldTime}'
  );
  create table public.system_config (
    key text primary key, value text, description text, updated_by uuid,
    updated_at timestamptz not null default '${oldTime}'
  );
  create table public.orders (
    id uuid primary key, user_id uuid not null, status text not null,
    total_amount_cny numeric(10,2), approved_at timestamptz, created_at timestamptz
  );
  create table public.order_items (
    id uuid primary key, order_id uuid not null references public.orders(id),
    product_id uuid not null references public.products(id), product_title text,
    quantity integer, unit_price_cny numeric(10,2), amount_cny numeric(10,2)
  );
  create table public.user_entitlements (
    id uuid primary key, user_id uuid not null, source_order_id uuid references public.orders(id),
    source_product_id uuid references public.products(id), entitlement_type text,
    project_id uuid, specialty_id uuid, status text, start_at timestamptz,
    end_at timestamptz, grant_reason text
  );
`;

async function fixture() {
  await db.exec('rollback');
  await db.exec(`
    reset role;
    drop schema if exists kidneysphere_release_private cascade;
    drop schema if exists public cascade;
    create schema public;
    grant usage on schema public to anon, authenticated, service_role;
    ${schema}
  `);
  let productNumber = 1;
  for (const [projectIndex, prefix] of prefixes.entries()) {
    const projectId = uuid(100 + projectIndex);
    const bundleId = uuid(productNumber);
    await db.query(`insert into learning_projects
      (id,project_code,title,registration_fee_cny,status,is_active,includes_bundle_product_id)
      values ($1,$2,$3,1280,$4,$5,$6)`,
    [projectId, `PROJ-${prefix}-2026`, `${prefix} 项目原名称`, projectIndex === 2 ? 'closed' : 'recruiting', projectIndex !== 2, bundleId]);
    for (const variant of ['BUNDLE', 'REG-FULL', 'REG-VIDEO']) {
      const number = productNumber++;
      const code = `${prefix}-${variant}-2026`;
      const price = variant === 'REG-FULL' ? 1280 : variant === 'BUNDLE' ? 980 : 780;
      const originalPrice = variant === 'REG-FULL' ? 1580 : variant === 'BUNDLE' ? 1200 : 980;
      const active = code !== 'GLOM-REG-FULL-2026' && code !== 'TX-BUNDLE-2026' && code !== 'DA-REG-VIDEO-2026';
      await db.query(`insert into products
        (id,product_code,product_type,title,subtitle,description,price_cny,list_price_cny,
          early_bird_deadline,duration_days,specialty_id,project_id,cohort_id,is_active)
        values ($1,$2,$3,$4,'早鸟优惠','早鸟价限时课程', $5,$6,'2026-05-30T15:59:59Z',730,$7,$8,$9,$10)`,
      [uuid(number), code, variant === 'BUNDLE' ? 'specialty_bundle' : 'project_registration',
        `${prefix} ${variant} 原商品名称`, price, originalPrice, uuid(200 + projectIndex),
        variant === 'BUNDLE' ? null : projectId, variant === 'REG-VIDEO' ? uuid(300 + projectIndex) : null, active]);
      await db.query(`insert into training_programs (id,title,product_code,price_cny,status,link)
        values ($1,$2,$3,$4,'recruiting',$5)`,
      [number, `展示卡 ${code}`, code, price, `training-${prefix.toLowerCase()}.html`]);
      await db.query(`insert into product_price_versions
        (id,product_id,version_name,list_price_cny,sale_price_cny,effective_start_at,effective_end_at,status)
        values ($1,$2,'早鸟档',$3,$4,'2026-03-23','2026-05-30','active'),
          ($5,$2,'已结束原档',$3,$4,'2026-01-01','2026-02-01','expired')`,
      [uuid(400 + number), uuid(number), originalPrice, price, uuid(500 + number)]);
    }
  }
  await db.exec(`
    insert into products (id,product_code,product_type,title,subtitle,description,price_cny,list_price_cny,
      early_bird_deadline,duration_days,is_active,video_id) values
      ('${uuid(900)}','MEMBERSHIP-YEARLY','membership_plan','教育会员','会员保留','会员说明',299,399,'2026-12-01',365,true,null),
      ('${uuid(901)}','VIDEO-STANDALONE','single_video','单课','单课保留','单课说明',50,80,null,30,true,'${uuid(902)}');
    insert into product_price_versions (id,product_id,version_name,list_price_cny,sale_price_cny,effective_start_at,status) values
      ('${uuid(903)}','${uuid(900)}','会员价格',399,299,'2026-01-01','active'),
      ('${uuid(904)}','${uuid(901)}','单课价格',80,50,'2026-01-01','active');
    insert into training_programs (id,title,product_code,price_cny,status,link) values
      (90,'未关联展示卡',null,777,'draft','unchanged.html'),
      (91,'空编码展示卡','',888,'draft','unchanged-too.html');
    insert into system_config (key,value,description,updated_by) values
      ('membership_yearly_price','299','会员价格原说明','${uuid(950)}'),
      ('single_video_default_price','50','单课价格原说明','${uuid(950)}'),
      ('specialty_bundle_default_price','980','原整套价','${uuid(950)}'),
      ('specialty_bundle_regular_price','1200','原整套正价','${uuid(950)}'),
      ('specialty_bundle_early_price','980','原整套早鸟','${uuid(950)}'),
      ('project_full_early_price','1280','原培训早鸟','${uuid(950)}'),
      ('project_video_early_price','780','原回放早鸟','${uuid(950)}'),
      ('project_video_regular_price','980','原回放正价','${uuid(950)}'),
      ('pricing_early_bird_deadline','2026-05-30','培训早鸟截止','${uuid(950)}'),
      ('brand_name','肾域','不相关设置','${uuid(950)}');
    insert into orders values
      ('${uuid(960)}','${uuid(970)}','approved',780,'2026-04-01','2026-03-30'),
      ('${uuid(961)}','${uuid(971)}','pending_review',1280,null,'2026-09-13');
    insert into order_items values
      ('${uuid(962)}','${uuid(960)}','${uuid(3)}','购买时回放版原标题',1,780,780),
      ('${uuid(963)}','${uuid(961)}','${uuid(5)}','购买时培训原标题',1,1280,1280);
    insert into user_entitlements values
      ('${uuid(964)}','${uuid(970)}','${uuid(960)}','${uuid(3)}','project_access','${uuid(100)}','${uuid(200)}','active','2026-04-01','2028-03-31','原订单回放权益'),
      ('${uuid(965)}','${uuid(972)}',null,'${uuid(900)}','membership',null,null,'active','2026-01-01',null,'历史无限期授权');
  `);
}

before(async () => {
  if (!PGlite) return;
  db = new PGlite();
  await db.waitReady;
  // Model permissive API-role defaults so the private schema must revoke them.
  await db.exec(`create role anon; create role authenticated; create role service_role;
    alter default privileges grant all on tables to anon, authenticated, service_role;
    alter default privileges grant execute on functions to anon, authenticated, service_role;`);
});
beforeEach(async () => { if (db) await fixture(); });
after(async () => { if (db) await db.close(); });

async function rows(sql, values = []) {
  return (await db.query(sql, values)).rows;
}
async function snapshot(tables, { includeUpdatedAt = false } = {}) {
  const result = {};
  for (const table of tables) {
    const expression = includeUpdatedAt ? 'to_jsonb(t)' : "to_jsonb(t) - 'updated_at'";
    result[table] = await rows(`select ${expression} as row from public.${table} t order by to_jsonb(t)::text`);
  }
  return result;
}
async function rejectedTransaction(sql, pattern) {
  await assert.rejects(db.exec(sql), pattern);
  // Explicit SQL BEGIN remains aborted after an error; the operator must roll it back.
  await db.exec('rollback');
}

test('the 15 exact SKUs get regular prices or retirement while original orders and rights remain unchanged', options, async () => {
  const beforeHistory = await snapshot(historyTables, { includeUpdatedAt: true });
  const beforeProducts = await rows('select * from products order by product_code');
  await db.exec(migration);
  const afterProducts = await rows('select * from products order by product_code');
  assert.equal(afterProducts.length, beforeProducts.length);
  for (const product of afterProducts) {
    const prior = beforeProducts.find(p => p.id === product.id);
    if (product.product_type === 'membership_plan' || product.product_type === 'single_video') {
      assert.deepEqual(product, prior);
      continue;
    }
    assert.equal(product.list_price_cny, null);
    assert.equal(product.early_bird_deadline, null);
    assert.doesNotMatch(`${product.subtitle} ${product.description}`, /早鸟/);
    if (product.product_code.includes('-REG-VIDEO-')) {
      assert.equal(product.is_active, false);
      assert.equal(product.price_cny, prior.price_cny, 'retirement must preserve the historical catalog price');
    } else {
      assert.equal(Number(product.price_cny), product.product_code.includes('-REG-FULL-') ? 1580 : 1200);
      assert.equal(product.is_active, prior.is_active, 'pricing must not activate a closed sale');
    }
    for (const field of ['id', 'title', 'product_type', 'duration_days', 'specialty_id', 'project_id', 'cohort_id', 'video_id', 'requires_review', 'created_at']) {
      assert.deepEqual(product[field], prior[field], `must preserve ${product.product_code}.${field}`);
    }
  }
  assert.deepEqual(await snapshot(historyTables, { includeUpdatedAt: true }), beforeHistory);
});

test('display prices, project fees and active training price versions change only in the intended catalog scope', options, async () => {
  const before = await snapshot(catalogTables);
  await db.exec(migration);
  for (const card of await rows('select * from training_programs order by id')) {
    const prior = before.training_programs.find(({ row }) => row.id === Number(card.id)).row;
    const expected = card.product_code?.includes('-REG-FULL-') ? 1580
      : card.product_code?.includes('-BUNDLE-') ? 1200
        : card.product_code?.includes('-REG-VIDEO-') ? null : Number(prior.price_cny);
    assert.equal(card.price_cny === null ? null : Number(card.price_cny), expected);
    for (const field of ['title', 'product_code', 'status', 'link', 'deleted_at']) assert.equal(card[field], prior[field]);
  }
  for (const project of await rows('select * from learning_projects')) {
    const prior = before.learning_projects.find(({ row }) => row.id === project.id).row;
    assert.equal(Number(project.registration_fee_cny), 1580);
    for (const field of ['project_code', 'title', 'status', 'is_active', 'requires_review', 'includes_bundle_product_id']) assert.equal(project[field], prior[field]);
  }
  for (const version of await rows('select * from product_price_versions')) {
    const prior = before.product_price_versions.find(({ row }) => row.id === version.id).row;
    const training = before.products.some(({ row }) => row.id === version.product_id && prefixes.some(prefix => row.product_code.startsWith(`${prefix}-`)));
    assert.equal(version.status, training && prior.status === 'active' ? 'expired' : prior.status);
    assert.equal(Number(version.sale_price_cny), Number(prior.sale_price_cny));
    assert.equal(Number(version.list_price_cny), Number(prior.list_price_cny));
    if (training && prior.status === 'active') assert.ok(version.effective_end_at);
  }
  const config = Object.fromEntries((await rows('select key,value from system_config')).map(r => [r.key, r.value]));
  assert.equal(config.specialty_bundle_default_price, '1200');
  assert.equal(config.specialty_bundle_regular_price, '1200');
  assert.equal(config.project_full_regular_price, '1580');
  assert.equal(config.membership_yearly_price, '299');
  assert.equal(config.single_video_default_price, '50');
  assert.equal(config.brand_name, '肾域');
  for (const key of ['specialty_bundle_early_price', 'project_full_early_price', 'project_video_early_price', 'project_video_regular_price', 'pricing_early_bird_deadline']) assert.equal(config[key], undefined, key);
});

test('running the migration twice preserves the first backup and makes no additional catalog writes', options, async () => {
  await db.exec(migration);
  const first = await snapshot(catalogTables, { includeUpdatedAt: true });
  const backup = await rows('select * from kidneysphere_release_private.training_price_changes order by table_name,row_key');
  const release = await rows('select * from kidneysphere_release_private.training_price_releases');
  await db.exec(migration);
  assert.deepEqual(await snapshot(catalogTables, { includeUpdatedAt: true }), first);
  assert.deepEqual(await rows('select * from kidneysphere_release_private.training_price_changes order by table_name,row_key'), backup);
  assert.deepEqual(await rows('select * from kidneysphere_release_private.training_price_releases'), release);
});

test('rollback restores catalog values and removed config rows, and supports safe no-op rollback and reapply', options, async () => {
  const original = await snapshot(catalogTables);
  const history = await snapshot(historyTables, { includeUpdatedAt: true });
  await db.exec(migration);
  const applied = await snapshot(catalogTables);
  await db.exec(rollback);
  assert.deepEqual(await snapshot(catalogTables), original);
  assert.equal((await rows('select state from kidneysphere_release_private.training_price_releases'))[0].state, 'rolled_back');
  const reverted = await snapshot(catalogTables, { includeUpdatedAt: true });
  await db.exec(rollback);
  assert.deepEqual(await snapshot(catalogTables, { includeUpdatedAt: true }), reverted);
  await db.exec(migration);
  assert.deepEqual(await snapshot(catalogTables), applied);
  assert.deepEqual(await snapshot(historyTables, { includeUpdatedAt: true }), history);
});

const blockedFixtures = [
  ['a missing required SKU', "delete from training_programs where product_code='PATHO-REG-VIDEO-2026'; delete from product_price_versions where product_id=(select id from products where product_code='PATHO-REG-VIDEO-2026'); delete from products where product_code='PATHO-REG-VIDEO-2026';", /missing SKU/],
  ['an unexpected required SKU type', "update products set product_type='membership_plan' where product_code='ICU-REG-FULL-2026';", /unexpected product_type/],
  ['an unknown training SKU', `insert into products (id,product_code,product_type,title,price_cny,is_active) values ('${uuid(999)}','NEW-REG-FULL-2027','project_registration','未映射培训',88,true);`, /unmapped training SKU/],
  ['a hidden project-linked SKU with another type', `update products set project_id='${uuid(100)}' where product_code='VIDEO-STANDALONE';`, /unmapped training SKU/],
  ['an unknown learning project', `insert into learning_projects (id,project_code,title,registration_fee_cny,status,is_active) values ('${uuid(999)}','PROJ-UNKNOWN-2027','新项目',55,'draft',false);`, /unmapped learning project/],
  ['a missing learning project', "delete from learning_projects where project_code='PROJ-DA-2026';", /missing learning project/],
  ['an unmapped training card', "update training_programs set product_code='UNKNOWN-CARD-PRODUCT' where id=90;", /unmapped product_code/],
];
for (const [label, setup, pattern] of blockedFixtures) {
  test(`preflight refuses ${label} and rolls back the entire release`, options, async () => {
    await db.exec(setup);
    const original = await snapshot([...catalogTables, ...historyTables], { includeUpdatedAt: true });
    await rejectedTransaction(migration, pattern);
    assert.deepEqual(await snapshot([...catalogTables, ...historyTables], { includeUpdatedAt: true }), original);
    assert.equal((await rows("select to_regnamespace('kidneysphere_release_private') as schema"))[0].schema, null);
  });
}

test('rollback refuses a later manual edit to any changed business field without partially reverting other rows', options, async () => {
  await db.exec(migration);
  await db.exec("update products set price_cny=1666 where product_code='TX-REG-FULL-2026'");
  const modified = await snapshot([...catalogTables, ...historyTables], { includeUpdatedAt: true });
  await rejectedTransaction(rollback, /PRICING_CONFLICT/);
  assert.deepEqual(await snapshot([...catalogTables, ...historyTables], { includeUpdatedAt: true }), modified);
  assert.equal((await rows('select state from kidneysphere_release_private.training_price_releases'))[0].state, 'applied');
});

test('a newly active training price version blocks rollback and rerun without disturbing the later price schedule', options, async () => {
  await db.exec(migration);
  await db.exec(`insert into product_price_versions
    (id,product_id,version_name,sale_price_cny,effective_start_at,status)
    values ('${uuid(990)}','${uuid(5)}','后续人工定价',1700,'2026-10-01','active')`);
  const modified = await snapshot([...catalogTables, ...historyTables], { includeUpdatedAt: true });
  await rejectedTransaction(rollback, /PRICING_(?:CONFLICT|VERIFY_FAILED|BLOCKED)/);
  assert.deepEqual(await snapshot([...catalogTables, ...historyTables], { includeUpdatedAt: true }), modified);
  await rejectedTransaction(migration, /PRICING_(?:CONFLICT|VERIFY_FAILED|BLOCKED)/);
  assert.deepEqual(await snapshot([...catalogTables, ...historyTables], { includeUpdatedAt: true }), modified);
});

test('rerun refuses an added linked training card that would retain an obsolete displayed price', options, async () => {
  await db.exec(migration);
  await db.exec("insert into training_programs (id,title,product_code,price_cny,status) values (99,'后续新卡','ICU-REG-FULL-2026',1280,'recruiting')");
  const modified = await snapshot(catalogTables, { includeUpdatedAt: true });
  await rejectedTransaction(migration, /PRICING_(?:CONFLICT|VERIFY_FAILED|BLOCKED)/);
  assert.deepEqual(await snapshot(catalogTables, { includeUpdatedAt: true }), modified);
});

test('rollback preserves later changes to fields that pricing never owned, such as recruitment and access duration', options, async () => {
  await db.exec(migration);
  await db.exec("update products set is_active=true,duration_days=900 where product_code='GLOM-REG-FULL-2026'; update learning_projects set status='ended' where project_code='PROJ-ICU-2026';");
  await db.exec(rollback);
  const [product] = await rows("select is_active,duration_days,price_cny from products where product_code='GLOM-REG-FULL-2026'");
  assert.equal(product.is_active, true);
  assert.equal(product.duration_days, 900);
  assert.equal(Number(product.price_cny), 1280);
  assert.equal((await rows("select status from learning_projects where project_code='PROJ-ICU-2026'"))[0].status, 'ended');
});

test('API roles cannot read pricing backups or invoke restoration, even with permissive default grants', options, async () => {
  await db.exec(migration);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const [privileges] = await rows(`select
      has_schema_privilege($1,'kidneysphere_release_private','USAGE') as schema_access,
      has_table_privilege($1,'kidneysphere_release_private.training_price_changes','SELECT') as backup_read,
      has_table_privilege($1,'kidneysphere_release_private.training_price_releases','SELECT') as release_read,
      has_function_privilege($1,'kidneysphere_release_private.restore_training_prices_20260914()','EXECUTE') as restore_execute`, [role]);
    assert.deepEqual(privileges, { schema_access: false, backup_read: false, release_read: false, restore_execute: false });
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query('select * from kidneysphere_release_private.training_price_changes'), /permission denied/);
      await assert.rejects(db.query('select kidneysphere_release_private.restore_training_prices_20260914()'), /permission denied/);
    } finally {
      await db.exec('reset role');
    }
  }
});
