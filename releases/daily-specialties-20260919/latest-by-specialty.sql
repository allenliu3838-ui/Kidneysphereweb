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
