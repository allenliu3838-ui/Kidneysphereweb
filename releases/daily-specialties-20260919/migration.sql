DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.get_daily_learning_today(text[])'::regprocedure)) <> '1e34e8b40b6df7fcd918e422364978ef' THEN RAISE EXCEPTION 'Daily feed changed; review current definition first'; END IF;
 IF to_regprocedure('public.get_daily_literature_by_specialty(text[])') IS NOT NULL THEN RAISE EXCEPTION 'Specialty feed already exists'; END IF;
END
$guard$;
-- One latest PUBLISHED literature interpretation per requested specialty.
-- SECURITY INVOKER preserves article RLS; no draft metadata is exposed.
CREATE OR REPLACE FUNCTION public.get_daily_literature_by_specialty(
  p_specialties text[] DEFAULT NULL::text[]
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
  with specialties(key,label,position,topic_tags) as (values
    ('glom','肾小球病',1,array['肾小球病','膜性肾病','IgA肾病','狼疮性肾炎']),
    ('icu','重症肾内',2,array['AKI/重症','AKI','重症肾内']),
    ('tx','肾移植',3,array['肾移植','肾移植内科']),
    ('path','肾脏病理',4,array['肾脏病理']),
    ('da','血管通路',5,array['血管通路','透析通路']),
    ('peds','儿童肾脏',6,array['儿童肾脏','儿童肾病','儿肾'])
  ), selected as (
    select * from specialties
    where coalesce(cardinality(p_specialties),0)=0 or key=any(p_specialties)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'specialty',s.key,'specialty_label',s.label,
    'article_id',a.id,'title',a.title,'summary',a.summary,
    'published_at',a.published_at,'cover_url',a.cover_url,
    'source_url',case when a.id is not null then
      'https://kidneysphere.com/article.html?id='||a.id::text end,
    'source_label',case when a.id is not null then
      '解读发布于 '||to_char(a.published_at at time zone 'Asia/Shanghai','YYYY-MM-DD') end,
    'available',a.id is not null
  ) order by s.position),'[]'::jsonb)
  from selected s
  left join lateral (
    select a.id,a.title,a.summary,a.published_at,a.cover_url
    from public.articles a
    where a.status='published' and a.deleted_at is null
      and a.published_at is not null and a.published_at<=now()
      and a.tags @> array['文献解读']::text[]
      and (
        a.tags @> array['specialty:'||s.key]::text[]
        or (not exists(select 1 from unnest(a.tags) t where t like 'specialty:%')
            and a.tags && s.topic_tags)
      )
    order by a.published_at desc,a.id
    limit 1
  ) a on true;
$function$;
REVOKE ALL ON FUNCTION public.get_daily_literature_by_specialty(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_literature_by_specialty(text[]) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.get_daily_literature_by_specialty(text[]) IS
  'Latest published literature per specialty; missing slots contain no draft details. Ordered by interpretation publication date.';

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
  where coalesce(cardinality(p_specialties),0)=0 or specialty=any(p_specialties)
  order by content_date desc,source_rank,sort_time desc,article_id
  limit 1
;
$function$;
