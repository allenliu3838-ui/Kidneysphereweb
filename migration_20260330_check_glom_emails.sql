-- ============================================================
-- migration_20260330_check_glom_emails.sql
--
-- 查询 28 个邮箱的肾小球培训项目权限开通状态
-- 在 Supabase SQL Editor 中运行即可
-- ============================================================

with email_list as (
  select unnest(array[
    '835810362@qq.com',
    '18535536987@163.com',
    '276799917@qq.com',
    'pipilu0329@163.com',
    'shenzang123@126.com',
    'ruibaobring@aliyun.com',
    'm19924740118@163.com',
    '3143165388@qq.com',
    '234598285@qq.com',
    '2653913490@qq.com',
    'fanxl8296@126.com',
    '673955230@qq.com',
    '809437805@qq.com',
    'mayunhua2013.sina.com',
    '441873515@qq.com',
    '13728368057@163.com',
    '280046819@qq.com',
    '605912394@qq.com',
    'lmchen526@126.com',
    'zymedsp@163.com',
    '375732774@qq.com',
    'zhxsqz@163.com',
    '472505875@qq.com',
    'm18023689150@163.com',
    '54464572@qq.com',
    '996471572@qq.com',
    '1811521920@qq.com'
  ]) as email
),
user_lookup as (
  select
    e.email,
    u.id as user_id,
    p.full_name
  from email_list e
  left join auth.users u on lower(u.email) = lower(e.email)
  left join public.profiles p on p.id = u.id
),
glom_project as (
  select id from public.learning_projects where project_code = 'PROJ-GLOM-2026' limit 1
),
entitlement_check as (
  select
    ul.email,
    ul.user_id,
    ul.full_name,
    case
      when ul.user_id is null then '❌ 未注册'
      when ue.id is not null and ue.status = 'active' then '✅ 已开通'
      when ue.id is not null and ue.status = 'revoked' then '⚠️ 已撤销'
      when ue.id is not null then '⚠️ ' || ue.status
      else '❌ 未开通'
    end as "状态",
    ue.status as ent_status,
    ue.start_at,
    ue.end_at
  from user_lookup ul
  cross join glom_project gp
  left join public.user_entitlements ue
    on ue.user_id = ul.user_id
    and ue.project_id = gp.id
    and ue.entitlement_type = 'project_access'
)
select
  row_number() over () as "#",
  email as "邮箱",
  coalesce(full_name, '') as "姓名",
  "状态",
  case when user_id is not null then user_id::text else '' end as "用户ID"
from entitlement_check
order by
  case
    when "状态" like '❌%' then 0
    when "状态" like '⚠️%' then 1
    else 2
  end,
  email;
