# 首页每日一学读取修复（2026-09-19）

## 现场问题

- 生产首页加载 `daily-learning.js?v=20260918_daily2`。
- `public.daily_learning_cards` 无记录；匿名 `get_daily_learning_today` 返回 null。
- 页面备用内容查询使用“每日一学”标签，而日更文章使用“临床日更”；生产 `/api/content` 备用地址还返回 404。
- 因此前端退回内置卡片；卡片按 UTC 日数循环，并不表示每天新增或发布。
- 本次查询发现 2026-09-18 日更文章已发布；2026-09-19 APD 文章为 in_review。
- 现有自动任务正常启用，负责每天准备待审稿，不能将运行成功当作公开发布。

## 已应用的修复

数据库迁移 `fix_daily_learning_published_feed` 已成功应用于现有生产项目。
只修改现有读取函数，不修改文章正文、审核状态、自动任务、权限或前端静态文件。

候选内容包含已发布的结构化题卡及带“临床日更”/“每日一学”标签的已发布文章。
先按北京时间内容日期排序，同日再优先关注方向与结构化题卡。
有结构化题卡的文章不重复作为普通文章候选，从而保留 active 与排期控制。
排除未发布、已删除、未来发布文章和未来排期题卡。
函数保持 SECURITY INVOKER、空 search_path 和原有 EXECUTE ACL，继续遵守 RLS。
普通文章保留已发布标题和摘要，显示发布日期，链接至原文；没有结构化题目时不生成或伪造问答。

## 验证

- 应用前以 anon 角色试算，正确返回 9 月 18 日已发布文章。
- 应用后默认及 glom+peds 偏好均返回最新已发布文章，不被较旧专科内容固定。
- 生产公开配置对应的匿名 HTTP RPC 返回 200，已由 null 变为已发布文章。
- 今日待审文章未公开。
- 数据库安全检查没有报告本函数相关问题；其他历史告警不在本次范围。

## 应用 SQL

应用前有函数定义 MD5 并发保护：`47628479745e4bf4b2ced45869267bac`。
以下 SQL 是本次已执行操作的记录，不应无检查地重复执行。

```sql
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
  IF (SELECT md5(pg_get_functiondef('public.get_daily_learning_today(text[])'::regprocedure))) <> '47628479745e4bf4b2ced45869267bac' THEN
    RAISE EXCEPTION 'Daily learning function changed since inspection; stop and re-review';
  END IF;
END;
$guard$;
CREATE OR REPLACE FUNCTION public.get_daily_learning_today(p_specialties text[] DEFAULT NULL::text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$

  with candidates as (
    select
      c.scheduled_date as content_date,
      c.specialty,
      0 as source_rank,
      c.updated_at as sort_time,
      c.article_id,
      jsonb_build_object(
        'article_id',c.article_id,'title',a.title,'summary',a.summary,
        'cover_url',a.cover_url,'specialty',c.specialty,
        'learning_objective',c.learning_objective,
        'key_points',to_jsonb(c.key_points),'estimated_minutes',c.estimated_minutes,
        'quiz_question',c.quiz_question,'quiz_options',to_jsonb(c.quiz_options),
        'correct_option',c.correct_option,'quiz_explanation',c.quiz_explanation,
        'source_label',c.source_label,'source_url',c.source_url,
        'scheduled_date',c.scheduled_date,
        'related_label',c.related_label,'related_href',c.related_href,
        'related_access',c.related_access
      ) as payload
    from public.daily_learning_cards c
    join public.articles a on a.id=c.article_id
    where c.active
      and c.scheduled_date <= (now() at time zone 'Asia/Shanghai')::date
      and a.status='published' and a.deleted_at is null
      and coalesce(a.published_at,a.created_at) <= now()

    union all

    select
      (a.published_at at time zone 'Asia/Shanghai')::date as content_date,
      case
        when a.tags && array['儿童肾脏','儿童肾病','儿肾']::text[] then 'peds'
        when a.tags && array['肾移植','肾移植内科']::text[] then 'tx'
        when a.tags && array['肾脏病理']::text[] then 'path'
        when a.tags && array['血管通路','透析通路']::text[] then 'da'
        when a.tags && array['AKI/重症','AKI','重症肾内']::text[] then 'icu'
        when a.tags && array['肾小球病','膜性肾病','IgA肾病','狼疮性肾炎']::text[] then 'glom'
        else 'other'
      end as specialty,
      1 as source_rank,
      a.published_at as sort_time,
      a.id as article_id,
      jsonb_build_object(
        'article_id',a.id,'title',a.title,'summary',a.summary,
        'cover_url',a.cover_url,
        'scheduled_date',(a.published_at at time zone 'Asia/Shanghai')::date,
        'published_at',a.published_at,
        'source_label','肾域临床日更 · 发布于 ' ||
          to_char(a.published_at at time zone 'Asia/Shanghai','YYYY-MM-DD'),
        'source_url','https://kidneysphere.com/article.html?id=' || a.id::text,
        'content_kind','published_article'
      ) as payload
    from public.articles a
    where a.status='published' and a.deleted_at is null
      and a.published_at is not null and a.published_at <= now()
      and a.tags && array['临床日更','每日一学']::text[]
      and not exists (
        select 1 from public.daily_learning_cards c where c.article_id=a.id
      )
  )
  select payload || jsonb_build_object('specialty',specialty)
  from candidates
  order by content_date desc,
    case when coalesce(cardinality(p_specialties),0)>0
      and specialty=any(p_specialties) then 0 else 1 end,
    source_rank,sort_time desc,article_id
  limit 1
;
$function$;
```

## 回滚参考

先确认生产函数仍与本次版本一致，避免覆盖后续工作；以下保留修改前定义。
无需变更权限、表结构或文章记录。

```sql
CREATE OR REPLACE FUNCTION public.get_daily_learning_today(p_specialties text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'article_id',c.article_id,
    'title',a.title,
    'summary',a.summary,
    'cover_url',a.cover_url,
    'specialty',c.specialty,
    'learning_objective',c.learning_objective,
    'key_points',to_jsonb(c.key_points),
    'estimated_minutes',c.estimated_minutes,
    'quiz_question',c.quiz_question,
    'quiz_options',to_jsonb(c.quiz_options),
    'correct_option',c.correct_option,
    'quiz_explanation',c.quiz_explanation,
    'source_label',c.source_label,
    'source_url',c.source_url,
    'scheduled_date',c.scheduled_date,
    'related_label',c.related_label,
    'related_href',c.related_href,
    'related_access',c.related_access
  )
  from public.daily_learning_cards c
  join public.articles a on a.id=c.article_id
  where c.active
    and c.scheduled_date <= ((now() at time zone 'Asia/Shanghai')::date)
    and a.status='published' and a.deleted_at is null
  order by
    case when coalesce(cardinality(p_specialties),0)>0 and c.specialty=any(p_specialties) then 0 else 1 end,
    c.scheduled_date desc,c.updated_at desc
  limit 1;
$function$

```

## 尚未改动

- 内置卡片的 UTC 轮换逻辑及其收藏问题属于静态前端后续修复。
- 每篇“一个问题、三个要点、一道题”的结构化题卡仍须生成、核对和入队；本修复不会把普通文章冒称完整题卡。
- 公开发布继续按既有人工审核流程；今天待审稿不能假称已经上线。
