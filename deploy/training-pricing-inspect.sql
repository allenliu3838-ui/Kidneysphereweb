-- Read-only catalog inspection. No orders, identities, payments or entitlements
-- are queried. Keep this explicit mapping aligned with the pricing migration.
-- mapping_status MUST be READY before executing the migration. Unknown codes are
-- reported for review; never infer their product type or project from a title.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';

with manifest(product_code, expected_type, variant, target_price, project_code) as (values
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
  ('DA-REG-VIDEO-2026', 'project_registration', 'retired_video', null, 'PROJ-DA-2026')
), issues as (
  select 'MISSING_OR_MISTYPED_SKU' as issue, m.product_code as code
  from manifest m left join public.products p using (product_code)
  where p.id is null or p.product_type is distinct from m.expected_type
  union all
  select 'UNMAPPED_TRAINING_SKU', p.product_code
  from public.products p left join manifest m using (product_code)
  where m.product_code is null and (
    p.product_type in ('specialty_bundle', 'project_registration', 'registration_plus_bundle')
    or p.project_id is not null or p.cohort_id is not null
  )
  union all
  select 'MISSING_PROJECT', m.project_code
  from (select distinct project_code from manifest) m
  left join public.learning_projects p using (project_code) where p.id is null
  union all
  select 'UNMAPPED_PROJECT', p.project_code from public.learning_projects p
  where not exists (select 1 from manifest m where m.project_code = p.project_code)
  union all
  select 'UNMAPPED_TRAINING_CARD', t.id::text || ':' || t.product_code
  from public.training_programs t
  where nullif(btrim(t.product_code), '') is not null
    and not exists (select 1 from manifest m where m.product_code = t.product_code)
), product_report as (
  select m.product_code, p.product_type, m.variant, p.price_cny as current_price,
    m.target_price, p.is_active as current_sale_switch,
    case when m.variant = 'retired_video' then false else p.is_active end as target_sale_switch,
    p.list_price_cny, p.early_bird_deadline, p.duration_days as unchanged_duration_days,
    p.project_id as unchanged_project_id, p.cohort_id as unchanged_cohort_id,
    (select count(*) from public.product_price_versions v
      where v.product_id = p.id and v.status = 'active') as active_versions_to_expire,
    p.subtitle as current_subtitle, p.description as current_description
  from manifest m left join public.products p using (product_code)
), project_report as (
  select p.project_code, p.registration_fee_cny as current_registration_fee,
    1580 as target_registration_fee, p.status as unchanged_recruitment_status,
    p.is_active as unchanged_active_switch
  from public.learning_projects p
  where p.project_code in (select project_code from manifest)
), card_report as (
  select t.id, t.title, t.product_code, t.price_cny as current_display_price,
    case when m.product_code is null then t.price_cny else m.target_price end as target_display_price,
    case when m.product_code is null then 'UNTOUCHED' else 'SYNC_EXACT_PRODUCT_CODE' end as action,
    t.status as unchanged_recruitment_status
  from public.training_programs t left join manifest m using (product_code)
)
select jsonb_build_object(
  'release', 'training-prices-20260914-v1',
  'mapping_status', case when exists (select 1 from issues) then 'BLOCKED' else 'READY' end,
  'issues', coalesce((select jsonb_agg(to_jsonb(i) order by i.issue, i.code) from issues i), '[]'::jsonb),
  'products', (select jsonb_agg(to_jsonb(p) order by p.product_code) from product_report p),
  'projects', (select jsonb_agg(to_jsonb(p) order by p.project_code) from project_report p),
  'training_cards', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from card_report t), '[]'::jsonb),
  'pricing_config', coalesce((select jsonb_agg(jsonb_build_object('key', c.key, 'value', c.value) order by c.key)
    from public.system_config c where c.key in (
      'specialty_bundle_default_price', 'specialty_bundle_regular_price', 'project_full_regular_price',
      'specialty_bundle_early_price', 'project_full_early_price', 'project_video_early_price', 'project_video_regular_price',
      'pricing_early_bird_deadline'
    )), '[]'::jsonb),
  'protected_data', 'Orders, payments, users, entitlements and sold durations are not read or changed by this inspection.'
) as training_pricing_inspection;

commit;
