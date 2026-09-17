-- Training pricing release: 2026-09-14, v1.
-- Run deploy/training-pricing-inspect.sql first. Execute as the database owner.
-- This changes catalog prices only. Orders, order_items, payment proofs,
-- entitlements, durations, project mappings and recruitment switches are untouched.
-- FULL/BUNDLE is_active is preserved; only the separate REG-VIDEO SKUs are retired.
-- Backup/restore data stays in a private schema (never add it to PostgREST schemas).
-- Rollback: deploy/training-pricing-rollback.sql. A conflicting later edit stops
-- restoration before any catalog row is changed. Updated-at metadata is refreshed.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('kidneysphere-training-prices-20260914-v1', 0));

-- Explicit mapping: do not infer a sale variant from the display title.
create temporary table ks_training_price_manifest (
  product_code text primary key,
  expected_type text not null,
  variant text not null,
  target_price numeric(10,2),
  project_code text not null
) on commit drop;
insert into ks_training_price_manifest values
  ('GLOM-BUNDLE-2026', 'specialty_bundle', 'bundle', 1200, 'PROJ-GLOM-2026'),
  ('GLOM-REG-FULL-2026', 'project_registration', 'full', 1580, 'PROJ-GLOM-2026'),
  ('GLOM-REG-VIDEO-2026', 'project_registration', 'retired_video', null, 'PROJ-GLOM-2026'),
  ('ICU-BUNDLE-2026', 'specialty_bundle', 'bundle', 1200, 'PROJ-ICU-2026'),
  ('ICU-REG-FULL-2026', 'project_registration', 'full', 1580, 'PROJ-ICU-2026'),
  ('ICU-REG-VIDEO-2026', 'project_registration', 'retired_video', null, 'PROJ-ICU-2026'),
  ('TX-BUNDLE-2026', 'specialty_bundle', 'bundle', 1200, 'PROJ-TX-2026'),
  ('TX-REG-FULL-2026', 'project_registration', 'full', 1580, 'PROJ-TX-2026'),
  ('TX-REG-VIDEO-2026', 'project_registration', 'retired_video', null, 'PROJ-TX-2026'),
  ('PATHO-BUNDLE-2026', 'specialty_bundle', 'bundle', 1200, 'PROJ-PATHO-2026'),
  ('PATHO-REG-FULL-2026', 'project_registration', 'full', 1580, 'PROJ-PATHO-2026'),
  ('PATHO-REG-VIDEO-2026', 'project_registration', 'retired_video', null, 'PROJ-PATHO-2026'),
  ('DA-BUNDLE-2026', 'specialty_bundle', 'bundle', 1200, 'PROJ-DA-2026'),
  ('DA-REG-FULL-2026', 'project_registration', 'full', 1580, 'PROJ-DA-2026'),
  ('DA-REG-VIDEO-2026', 'project_registration', 'retired_video', null, 'PROJ-DA-2026');

-- Serialize catalog writes while taking the backup and applying it. Readers remain
-- available. A busy catalog causes a timeout and a complete transaction rollback.
lock table public.products, public.product_price_versions,
  public.training_programs, public.learning_projects, public.system_config
  in share row exclusive mode;

do $$
declare problems text;
begin
  select string_agg(m.product_code, ', ' order by m.product_code) into problems
  from ks_training_price_manifest m
  left join public.products p using (product_code)
  where p.id is null or p.product_type is distinct from m.expected_type;
  if problems is not null then
    raise exception 'PRICING_BLOCKED: missing SKU or unexpected product_type: %', problems;
  end if;

  select string_agg(p.product_code, ', ' order by p.product_code) into problems
  from public.products p left join ks_training_price_manifest m using (product_code)
  where m.product_code is null and (
    p.product_type in ('specialty_bundle', 'project_registration', 'registration_plus_bundle')
    or p.project_id is not null or p.cohort_id is not null
  );
  if problems is not null then
    raise exception 'PRICING_BLOCKED: unmapped training SKU; inspect and explicitly map it: %', problems;
  end if;

  select string_agg(p.project_code, ', ' order by p.project_code) into problems
  from public.learning_projects p
  where not exists (select 1 from ks_training_price_manifest m where m.project_code = p.project_code);
  if problems is not null then
    raise exception 'PRICING_BLOCKED: unmapped learning project: %', problems;
  end if;
  select string_agg(m.project_code, ', ' order by m.project_code) into problems
  from (select distinct project_code from ks_training_price_manifest) m
  left join public.learning_projects p using (project_code) where p.id is null;
  if problems is not null then
    raise exception 'PRICING_BLOCKED: missing learning project: %', problems;
  end if;

  select string_agg(t.id::text || ':' || t.product_code, ', ' order by t.id) into problems
  from public.training_programs t
  where nullif(btrim(t.product_code), '') is not null
    and not exists (select 1 from ks_training_price_manifest m where m.product_code = t.product_code);
  if problems is not null then
    raise exception 'PRICING_BLOCKED: training card has an unmapped product_code: %', problems;
  end if;
end $$;

create schema if not exists kidneysphere_release_private;
revoke all on schema kidneysphere_release_private from public;
create table if not exists kidneysphere_release_private.training_price_releases (
  release_key text primary key,
  state text not null check (state in ('applied', 'rolled_back')),
  applied_at timestamptz not null default now(),
  rolled_back_at timestamptz
);
create table if not exists kidneysphere_release_private.training_price_changes (
  release_key text not null references kidneysphere_release_private.training_price_releases(release_key),
  table_name text not null check (table_name in
    ('products', 'training_programs', 'learning_projects', 'system_config', 'product_price_versions')),
  row_key text not null,
  column_names text[] not null,
  before_values jsonb,
  after_values jsonb,
  primary key (release_key, table_name, row_key)
);

-- Internal helpers are SECURITY INVOKER and private; no service/frontend RPC exists.
create or replace function kidneysphere_release_private.training_price_snapshot(
  p_table text, p_key text, p_columns text[]
) returns jsonb language plpgsql security invoker set search_path = pg_catalog as $$
declare result jsonb; key_column text;
begin
  if p_table not in ('products', 'training_programs', 'learning_projects', 'system_config', 'product_price_versions') then
    raise exception 'Unsupported pricing table';
  end if;
  key_column := case when p_table = 'system_config' then 'key' else 'id' end;
  execute format('select jsonb_object_agg(c, to_jsonb(t)->c) from public.%I t cross join unnest($2::text[]) c where t.%I::text = $1 group by t.%I',
    p_table, key_column, key_column)
    into result using p_key, p_columns;
  return result;
end $$;

create or replace function kidneysphere_release_private.training_price_write(
  p_table text, p_key text, p_columns text[], p_expected jsonb, p_target jsonb
) returns void language plpgsql security invoker set search_path = pg_catalog as $$
declare key_column text; column_list text; value_list text; assignments text; current_values jsonb;
begin
  current_values := kidneysphere_release_private.training_price_snapshot(p_table, p_key, p_columns);
  if current_values is distinct from p_expected then
    raise exception 'PRICING_CONFLICT: %.% changed after the saved snapshot; no automatic overwrite', p_table, p_key;
  end if;
  key_column := case when p_table = 'system_config' then 'key' else 'id' end;
  if p_target is null then
    if p_table <> 'system_config' then raise exception 'Only obsolete config keys can be removed'; end if;
    execute format('delete from public.%I where %I::text = $1', p_table, key_column) using p_key;
  elsif p_expected is null then
    if p_table <> 'system_config' then raise exception 'Only pricing config keys can be inserted'; end if;
    select string_agg(format('%I', c), ', '), string_agg(format('r.%I', c), ', ')
      into column_list, value_list from unnest(array_prepend(key_column, p_columns)) c;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) r',
      p_table, column_list, value_list, p_table)
      using p_target || jsonb_build_object(key_column, p_key);
  else
    select string_agg(format('%I = r.%I', c, c), ', ') into assignments from unnest(p_columns) c;
    -- updated_at is bookkeeping, never an entitlement duration or order timestamp.
    if p_table <> 'product_price_versions' and not ('updated_at' = any(p_columns)) then
      assignments := assignments || ', updated_at = now()';
    end if;
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.%I::text = $2',
      p_table, assignments, p_table, key_column) using p_target, p_key;
  end if;
  if kidneysphere_release_private.training_price_snapshot(p_table, p_key, p_columns) is distinct from p_target then
    raise exception 'PRICING_VERIFY_FAILED: %.%', p_table, p_key;
  end if;
end $$;

create or replace function kidneysphere_release_private.restore_training_prices_20260914()
returns jsonb language plpgsql security invoker set search_path = pg_catalog as $$
declare r record; release_state text; changed_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('kidneysphere-training-prices-20260914-v1', 0));
  lock table public.products, public.product_price_versions, public.training_programs,
    public.learning_projects, public.system_config in share row exclusive mode;
  select state into release_state from kidneysphere_release_private.training_price_releases
    where release_key = 'training-prices-20260914-v1' for update;
  if release_state is null then raise exception 'No training pricing backup exists'; end if;
  if release_state = 'rolled_back' then return jsonb_build_object('status', 'ALREADY_ROLLED_BACK'); end if;
  -- A newly scheduled price version was not in the original backup. Restoring an
  -- old active version beside it would silently create conflicting price rules.
  if exists (
    select 1 from public.product_price_versions v join public.products p on p.id = v.product_id
    where v.status = 'active' and p.product_code in (
      'GLOM-BUNDLE-2026', 'GLOM-REG-FULL-2026', 'GLOM-REG-VIDEO-2026',
      'ICU-BUNDLE-2026', 'ICU-REG-FULL-2026', 'ICU-REG-VIDEO-2026',
      'TX-BUNDLE-2026', 'TX-REG-FULL-2026', 'TX-REG-VIDEO-2026',
      'PATHO-BUNDLE-2026', 'PATHO-REG-FULL-2026', 'PATHO-REG-VIDEO-2026',
      'DA-BUNDLE-2026', 'DA-REG-FULL-2026', 'DA-REG-VIDEO-2026'
    )
  ) then raise exception 'PRICING_CONFLICT: a training price version was activated after release; rollback stopped'; end if;
  -- Validate every affected row first, then restore all of them in this transaction.
  for r in select * from kidneysphere_release_private.training_price_changes
    where release_key = 'training-prices-20260914-v1' order by table_name, row_key loop
    if kidneysphere_release_private.training_price_snapshot(r.table_name, r.row_key, r.column_names) is distinct from r.after_values then
      raise exception 'PRICING_CONFLICT: %.% changed after release; rollback stopped', r.table_name, r.row_key;
    end if;
  end loop;
  for r in select * from kidneysphere_release_private.training_price_changes
    where release_key = 'training-prices-20260914-v1' order by table_name, row_key loop
    perform kidneysphere_release_private.training_price_write(r.table_name, r.row_key, r.column_names, r.after_values, r.before_values);
    changed_count := changed_count + 1;
  end loop;
  update kidneysphere_release_private.training_price_releases set state = 'rolled_back', rolled_back_at = now()
    where release_key = 'training-prices-20260914-v1';
  return jsonb_build_object('status', 'ROLLED_BACK', 'restored_rows', changed_count);
end $$;

-- Prevent API roles from reading backup tables or calling any restore helper.
revoke all on all tables in schema kidneysphere_release_private from public;
revoke all on all functions in schema kidneysphere_release_private from public;
do $$ declare role_name text; begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on schema kidneysphere_release_private from %I', role_name);
      execute format('revoke all on all tables in schema kidneysphere_release_private from %I', role_name);
      execute format('revoke all on all functions in schema kidneysphere_release_private from %I', role_name);
    end if;
  end loop;
end $$;

do $$
declare
  r record; state_now text; before_json jsonb; after_json jsonb; columns_now text[];
  release_id constant text := 'training-prices-20260914-v1'; changed_count integer := 0;
begin
  select state into state_now from kidneysphere_release_private.training_price_releases where release_key = release_id;
  if state_now is not null then
    for r in select * from kidneysphere_release_private.training_price_changes where release_key = release_id order by table_name, row_key loop
      if kidneysphere_release_private.training_price_snapshot(r.table_name, r.row_key, r.column_names)
         is distinct from (case when state_now = 'applied' then r.after_values else r.before_values end) then
        raise exception 'PRICING_CONFLICT: %.% differs from saved release; inspect before rerunning', r.table_name, r.row_key;
      end if;
    end loop;
    if state_now = 'applied' then raise notice 'NO_CHANGE: training pricing release already applied'; return; end if;
    for r in select * from kidneysphere_release_private.training_price_changes where release_key = release_id order by table_name, row_key loop
      perform kidneysphere_release_private.training_price_write(r.table_name, r.row_key, r.column_names, r.before_values, r.after_values);
    end loop;
    update kidneysphere_release_private.training_price_releases set state = 'applied', applied_at = now(), rolled_back_at = null where release_key = release_id;
    raise notice 'REAPPLIED: existing verified backup retained'; return;
  end if;

  insert into kidneysphere_release_private.training_price_releases (release_key, state) values (release_id, 'applied');

  for r in select p.id, m.variant, m.target_price from public.products p join ks_training_price_manifest m using (product_code) loop
    columns_now := array['list_price_cny', 'early_bird_deadline', 'subtitle', 'description'];
    after_json := jsonb_build_object('list_price_cny', null, 'early_bird_deadline', null);
    if r.variant = 'retired_video' then
      columns_now := columns_now || array['is_active'];
      after_json := after_json || jsonb_build_object('is_active', false,
        'subtitle', '单独回放版已停售', 'description', '本商品已停售，既有订单与已购权益按原约定执行。');
    elsif r.variant = 'full' then
      columns_now := columns_now || array['price_cny'];
      after_json := after_json || jsonb_build_object('price_cny', r.target_price,
        'subtitle', '直播互动、专属学习群与课程回放', 'description', '培训报名完整版，统一价格 ¥1,580。直播互动、专属学习群与课程回放，具体安排以项目说明为准。');
    else
      columns_now := columns_now || array['price_cny'];
      after_json := after_json || jsonb_build_object('price_cny', r.target_price,
        'subtitle', '专科整套视频课程', 'description', '专科整套视频课程，统一价格 ¥1,200。课程范围与学习期限以购买时的商品约定为准。');
    end if;
    before_json := kidneysphere_release_private.training_price_snapshot('products', r.id::text, columns_now);
    if before_json is distinct from after_json then
      insert into kidneysphere_release_private.training_price_changes values (release_id, 'products', r.id::text, columns_now, before_json, after_json);
    end if;
  end loop;

  for r in select t.id, m.target_price from public.training_programs t join ks_training_price_manifest m using (product_code) loop
    columns_now := array['price_cny'];
    before_json := kidneysphere_release_private.training_price_snapshot('training_programs', r.id::text, columns_now);
    -- Retired card price is cleared, but its status, link and product_code stay intact.
    after_json := jsonb_build_object('price_cny', r.target_price);
    if before_json is distinct from after_json then
      insert into kidneysphere_release_private.training_price_changes values (release_id, 'training_programs', r.id::text, columns_now, before_json, after_json);
    end if;
  end loop;

  for r in select p.id from public.learning_projects p where p.project_code in (select project_code from ks_training_price_manifest) loop
    columns_now := array['registration_fee_cny'];
    before_json := kidneysphere_release_private.training_price_snapshot('learning_projects', r.id::text, columns_now);
    after_json := jsonb_build_object('registration_fee_cny', 1580);
    if before_json is distinct from after_json then
      insert into kidneysphere_release_private.training_price_changes values (release_id, 'learning_projects', r.id::text, columns_now, before_json, after_json);
    end if;
  end loop;

  for r in select v.id from public.product_price_versions v join public.products p on p.id = v.product_id
    join ks_training_price_manifest m using (product_code) where v.status = 'active' loop
    columns_now := array['status', 'effective_end_at'];
    before_json := kidneysphere_release_private.training_price_snapshot('product_price_versions', r.id::text, columns_now);
    after_json := jsonb_build_object('status', 'expired', 'effective_end_at', now());
    insert into kidneysphere_release_private.training_price_changes values (release_id, 'product_price_versions', r.id::text, columns_now, before_json, after_json);
  end loop;

  for r in select * from (values
    ('specialty_bundle_default_price', '1200', '专科整套视频课统一价格(元)'),
    ('specialty_bundle_regular_price', '1200', '专科整套视频课统一价格(元)'),
    ('project_full_regular_price', '1580', '培训报名完整版统一价格(元)'),
    ('specialty_bundle_early_price', null, null),
    ('project_full_early_price', null, null),
    ('project_video_early_price', null, null),
    ('project_video_regular_price', null, null),
    ('pricing_early_bird_deadline', null, null)
  ) configs(config_key, config_value, config_description) loop
    columns_now := case when r.config_value is null
      then array['value', 'description', 'updated_by', 'updated_at']
      else array['value', 'description'] end;
    before_json := kidneysphere_release_private.training_price_snapshot('system_config', r.config_key, columns_now);
    after_json := case when r.config_value is null then null else jsonb_build_object('value', r.config_value, 'description', r.config_description) end;
    if before_json is distinct from after_json then
      insert into kidneysphere_release_private.training_price_changes values (release_id, 'system_config', r.config_key, columns_now, before_json, after_json);
    end if;
  end loop;

  for r in select * from kidneysphere_release_private.training_price_changes where release_key = release_id order by table_name, row_key loop
    perform kidneysphere_release_private.training_price_write(r.table_name, r.row_key, r.column_names, r.before_values, r.after_values);
    changed_count := changed_count + 1;
  end loop;
  raise notice 'PRICING_APPLIED: % catalog rows updated; private backup saved; orders and entitlements untouched', changed_count;
end $$;

-- Also check unchanged/no-op rows: a later added card or price version must not
-- make a repeated release silently report success with an inconsistent catalog.
do $$ begin
  if exists (
    select 1 from public.products p join ks_training_price_manifest m using (product_code)
    where p.list_price_cny is not null or p.early_bird_deadline is not null
      or (m.variant = 'retired_video' and p.is_active is distinct from false)
      or (m.variant <> 'retired_video' and p.price_cny is distinct from m.target_price)
  ) then raise exception 'PRICING_VERIFY_FAILED: product prices, discounts or retired sale switches'; end if;
  if exists (
    select 1 from public.product_price_versions v join public.products p on p.id = v.product_id
    join ks_training_price_manifest m using (product_code) where v.status = 'active'
  ) then raise exception 'PRICING_VERIFY_FAILED: active training price versions remain'; end if;
  if exists (
    select 1 from public.learning_projects p
    where p.project_code in (select project_code from ks_training_price_manifest)
      and p.registration_fee_cny is distinct from 1580::numeric
  ) then raise exception 'PRICING_VERIFY_FAILED: learning project display fee'; end if;
  if exists (
    select 1 from public.training_programs t join ks_training_price_manifest m using (product_code)
    where t.price_cny is distinct from m.target_price
  ) then raise exception 'PRICING_VERIFY_FAILED: mapped training card display price'; end if;
  if exists (
    select 1 from public.system_config where key in (
      'specialty_bundle_early_price', 'project_full_early_price', 'project_video_early_price',
      'project_video_regular_price', 'pricing_early_bird_deadline'
    )
  ) then raise exception 'PRICING_VERIFY_FAILED: obsolete pricing config remains'; end if;
  if (select count(*) from public.system_config where
    (key in ('specialty_bundle_default_price', 'specialty_bundle_regular_price') and value = '1200')
    or (key = 'project_full_regular_price' and value = '1580')) <> 3
  then raise exception 'PRICING_VERIFY_FAILED: canonical pricing config'; end if;
end $$;

commit;
