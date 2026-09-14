-- Read-only catalog/schema inspection. Does not read customer orders or proofs.
-- Run before release as database owner. Use the admin anomaly RPC after release
-- only when explicitly reviewing customer fulfillment.
begin transaction isolation level repeatable read read only;
select p.product_code,p.product_type,s.code as specialty_code,p.is_active,p.price_cny,p.duration_days,
 p.project_id,lp.project_code,p.cohort_id,c.cohort_code,c.project_id as cohort_project_id,
 case when p.product_code in ('GLOM-REG-FULL-2026','ICU-REG-FULL-2026','TX-REG-FULL-2026','PATHO-REG-FULL-2026','DA-REG-FULL-2026') then 'FULL: training enrollment'
 when p.product_code in ('GLOM-BUNDLE-2026','ICU-BUNDLE-2026','TX-BUNDLE-2026','PATHO-BUNDLE-2026','DA-BUNDLE-2026') then 'BUNDLE: videos only'
 when p.product_code in ('GLOM-REG-VIDEO-2026','ICU-REG-VIDEO-2026','TX-REG-VIDEO-2026','PATHO-REG-VIDEO-2026','DA-REG-VIDEO-2026') then 'VIDEO: retired, historical videos only'
 else 'UNMAPPED: block release' end as expected_rights
from public.products p left join public.specialties s on s.id=p.specialty_id
left join public.learning_projects lp on lp.id=p.project_id left join public.cohorts c on c.id=p.cohort_id
where p.product_type in ('specialty_bundle','project_registration','registration_plus_bundle')
 or p.project_id is not null or p.cohort_id is not null order by p.product_code;
select lp.project_code,b.product_code as included_bundle,s.code as bundle_specialty
from public.learning_projects lp left join public.products b on b.id=lp.includes_bundle_product_id
left join public.specialties s on s.id=b.specialty_id order by lp.project_code;
select p.oid::regprocedure::text as function_signature,pg_get_functiondef(p.oid) as definition,p.proacl::text as acl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
and p.proname in ('create_order_with_items','submit_order_for_review','submit_payment_proof','admin_approve_order',
'admin_approve_order_verified','admin_reject_order','admin_revoke_order_approval','get_my_enrollments','get_my_learning_enrollments',
'admin_repair_order_enrollment','get_payment_enrollment_release','admin_get_study_groups') order by 1;
select c.relname,c.relacl::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('orders','order_items','payment_proofs','project_enrollments','cohorts','study_groups') order by c.relname;
select table_name,column_name,grantee,privilege_type from information_schema.column_privileges
where table_schema='public' and ((table_name='cohorts' and column_name in ('group_qr_url','group_qr_backup_url'))
 or (table_name='study_groups' and column_name in ('qr_url','qr_backup_url'))) order by grantee,column_name;
select to_regprocedure('public.get_payment_enrollment_release()') as release_rpc,
 to_regclass('kidneysphere_release_private.payment_enrollment_releases') as private_release_journal;
commit;
