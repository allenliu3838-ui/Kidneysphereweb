-- MIGRATION_20260211_SITE_SEARCH.sql
-- Internal site search ("search engine") for KidneySphere
--
-- Design goals
-- - Works well for Chinese + English without special tokenizer extensions.
-- - Fast substring search via pg_trgm GIN indexes.
-- - Unified search results across Articles / Cases / Moments / Events / Research / Experts.
-- - RLS-safe: the RPC runs as the caller (security invoker) so existing policies apply.

-- ---------------------------------------------------------
-- 0) Extensions
-- ---------------------------------------------------------

create extension if not exists pg_trgm;

-- ---------------------------------------------------------
-- 1) Helpers
-- ---------------------------------------------------------

-- Collapse whitespace to keep snippets compact.
create or replace function public.ks_norm_text(input text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(coalesce(input,''), '\s+', ' ', 'g'))
$$;

-- Very small HTML stripper for search indexing.
-- Note: not a full HTML parser, but good enough for turning sanitized HTML into searchable plain text.
create or replace function public.ks_strip_html(input text)
returns text
language sql
immutable
as $$
  select public.ks_norm_text(regexp_replace(coalesce(input,''), '<[^>]+>', ' ', 'g'))
$$;

-- ---------------------------------------------------------
-- 2) Add search_text columns (optional, safe)
-- ---------------------------------------------------------

alter table if exists public.articles add column if not exists search_text text;
alter table if exists public.cases add column if not exists search_text text;
alter table if exists public.moments add column if not exists search_text text;
alter table if exists public.event_series add column if not exists search_text text;
alter table if exists public.research_projects add column if not exists search_text text;
alter table if exists public.about_showcase add column if not exists search_text text;

comment on column public.articles.search_text is 'Auto-generated plain text for internal search (pg_trgm).';
comment on column public.cases.search_text is 'Auto-generated plain text for internal search (pg_trgm).';
comment on column public.moments.search_text is 'Auto-generated plain text for internal search (pg_trgm).';
comment on column public.event_series.search_text is 'Auto-generated plain text for internal search (pg_trgm).';
comment on column public.research_projects.search_text is 'Auto-generated plain text for internal search (pg_trgm).';
comment on column public.about_showcase.search_text is 'Auto-generated plain text for internal search (pg_trgm).';

-- ---------------------------------------------------------
-- 3) Triggers to keep search_text in sync
-- ---------------------------------------------------------

-- Articles
create or replace function public.trg_articles_set_search_text()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  j jsonb;
  content_html text;
begin
  -- Avoid hard dependency on optional columns like content_html.
  -- If the rich-text migration hasn't run, the key will be missing => treated as empty string.
  j := to_jsonb(new);
  content_html := coalesce(j->>'content_html','');
  new.search_text := public.ks_norm_text(
    coalesce(new.title,'') || ' ' ||
    coalesce(new.summary,'') || ' ' ||
    coalesce(array_to_string(new.tags,' '),'') || ' ' ||
    coalesce(new.content_md,'') || ' ' ||
    public.ks_strip_html(content_html)
  );
  return new;
end;
$$;

drop trigger if exists trg_articles_search_text on public.articles;
create trigger trg_articles_search_text
before insert or update
on public.articles
for each row execute function public.trg_articles_set_search_text();

-- Cases
create or replace function public.trg_cases_set_search_text()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  j jsonb;
  summary_html text;
begin
  -- Avoid hard dependency on optional columns like summary_html.
  j := to_jsonb(new);
  summary_html := coalesce(j->>'summary_html','');
  new.search_text := public.ks_norm_text(
    coalesce(new.title,'') || ' ' ||
    coalesce(new.summary,'') || ' ' ||
    public.ks_strip_html(summary_html) || ' ' ||
    coalesce(array_to_string(new.tags,' '),'') || ' ' ||
    coalesce(new.board,'') || ' ' ||
    coalesce(new.author_name,'')
  );
  return new;
end;
$$;

drop trigger if exists trg_cases_search_text on public.cases;
create trigger trg_cases_search_text
before insert or update
on public.cases
for each row execute function public.trg_cases_set_search_text();

-- Moments
create or replace function public.trg_moments_set_search_text()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_text := public.ks_norm_text(
    coalesce(new.content,'') || ' ' ||
    coalesce(new.author_name,'') || ' ' ||
    coalesce(new.video_url,'')
  );
  return new;
end;
$$;

drop trigger if exists trg_moments_search_text on public.moments;
create trigger trg_moments_search_text
before insert or update of content, author_name, video_url
on public.moments
for each row execute function public.trg_moments_set_search_text();

-- Events
create or replace function public.trg_event_series_set_search_text()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_text := public.ks_norm_text(
    coalesce(new.title_zh,'') || ' ' ||
    coalesce(new.title_en,'') || ' ' ||
    coalesce(new.platform,'') || ' ' ||
    coalesce(new.description,'') || ' ' ||
    coalesce(new.rule_zh,'') || ' ' ||
    coalesce(new.status,'') || ' ' ||
    coalesce(new.speaker_name,'') || ' ' ||
    coalesce(new.speaker_title,'') || ' ' ||
    coalesce(new.speaker_bio,'')
  );
  return new;
end;
$$;

drop trigger if exists trg_event_series_search_text on public.event_series;
create trigger trg_event_series_search_text
before insert or update of title_zh, title_en, platform, description, rule_zh, status, speaker_name, speaker_title, speaker_bio
on public.event_series
for each row execute function public.trg_event_series_set_search_text();

-- Research projects
create or replace function public.trg_research_projects_set_search_text()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_text := public.ks_norm_text(
    coalesce(new.title,'') || ' ' ||
    coalesce(new.status,'') || ' ' ||
    coalesce(new.study_type,'') || ' ' ||
    coalesce(new.summary,'') || ' ' ||
    coalesce(new.pi,'')
  );
  return new;
end;
$$;

drop trigger if exists trg_research_projects_search_text on public.research_projects;
create trigger trg_research_projects_search_text
before insert or update of title, status, study_type, summary, pi
on public.research_projects
for each row execute function public.trg_research_projects_set_search_text();

-- About showcase (experts/partners/flagship)
create or replace function public.trg_about_showcase_set_search_text()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_text := public.ks_norm_text(
    coalesce(new.category,'') || ' ' ||
    coalesce(new.title,'') || ' ' ||
    coalesce(new.description,'')
  );
  return new;
end;
$$;

drop trigger if exists trg_about_showcase_search_text on public.about_showcase;
create trigger trg_about_showcase_search_text
before insert or update of category, title, description
on public.about_showcase
for each row execute function public.trg_about_showcase_set_search_text();

-- ---------------------------------------------------------
-- 4) Backfill existing rows (safe)
-- ---------------------------------------------------------

update public.articles a
set search_text = public.ks_norm_text(
  coalesce(a.title,'') || ' ' ||
  coalesce(a.summary,'') || ' ' ||
  coalesce(array_to_string(a.tags,' '),'') || ' ' ||
  coalesce(a.content_md,'') || ' ' ||
  public.ks_strip_html(coalesce(to_jsonb(a)->>'content_html',''))
);

update public.cases c
set search_text = public.ks_norm_text(
  coalesce(c.title,'') || ' ' ||
  coalesce(c.summary,'') || ' ' ||
  public.ks_strip_html(coalesce(to_jsonb(c)->>'summary_html','')) || ' ' ||
  coalesce(array_to_string(c.tags,' '),'') || ' ' ||
  coalesce(c.board,'') || ' ' ||
  coalesce(c.author_name,'')
);

update public.moments m
set search_text = public.ks_norm_text(
  coalesce(m.content,'') || ' ' ||
  coalesce(m.author_name,'') || ' ' ||
  coalesce(m.video_url,'')
);

update public.event_series e
set search_text = public.ks_norm_text(
  coalesce(e.title_zh,'') || ' ' ||
  coalesce(e.title_en,'') || ' ' ||
  coalesce(e.platform,'') || ' ' ||
  coalesce(e.description,'') || ' ' ||
  coalesce(e.rule_zh,'') || ' ' ||
  coalesce(e.status,'') || ' ' ||
  coalesce(e.speaker_name,'') || ' ' ||
  coalesce(e.speaker_title,'') || ' ' ||
  coalesce(e.speaker_bio,'')
);

update public.research_projects rp
set search_text = public.ks_norm_text(
  coalesce(rp.title,'') || ' ' ||
  coalesce(rp.status,'') || ' ' ||
  coalesce(rp.study_type,'') || ' ' ||
  coalesce(rp.summary,'') || ' ' ||
  coalesce(rp.pi,'')
);

update public.about_showcase s
set search_text = public.ks_norm_text(
  coalesce(s.category,'') || ' ' ||
  coalesce(s.title,'') || ' ' ||
  coalesce(s.description,'')
);

-- ---------------------------------------------------------
-- 5) Indexes (pg_trgm)
-- ---------------------------------------------------------

-- Articles: consider keeping all rows indexed (admins may search drafts)
create index if not exists idx_articles_search_text_trgm
on public.articles using gin (search_text gin_trgm_ops);

-- Cases/Moments: soft-delete aware partial indexes
create index if not exists idx_cases_search_text_trgm_live
on public.cases using gin (search_text gin_trgm_ops)
where deleted_at is null;

create index if not exists idx_moments_search_text_trgm_live
on public.moments using gin (search_text gin_trgm_ops)
where deleted_at is null;

create index if not exists idx_event_series_search_text_trgm
on public.event_series using gin (search_text gin_trgm_ops);

create index if not exists idx_research_projects_search_text_trgm
on public.research_projects using gin (search_text gin_trgm_ops);

create index if not exists idx_about_showcase_search_text_trgm
on public.about_showcase using gin (search_text gin_trgm_ops);

-- ---------------------------------------------------------
-- 6) RPC: unified search across the site
-- ---------------------------------------------------------

-- NOTE: security invoker (default) => respects RLS.
-- - anon will only see public tables (articles published, moments, events, about_showcase, research).
-- - authenticated will also see cases/case comments per policies.

create or replace function public.search_site(
  q text,
  limit_count int default 30,
  offset_count int default 0,
  types text[] default null
)
returns table(
  type text,
  id text,
  title text,
  snippet text,
  url text,
  created_at timestamptz,
  score real,
  extra jsonb
)
language sql
stable
set search_path = public
as $$
  with p as (
    select
      trim(coalesce(q,'')) as q,
      lower(trim(coalesce(q,''))) as ql,
      greatest(1, least(coalesce(limit_count, 30), 50)) as lim,
      greatest(0, coalesce(offset_count, 0)) as off,
      types as types
  ),

  articles as (
    select
      'article'::text as type,
      a.id::text as id,
      a.title as title,
      case
        when p.ql <> '' and strpos(lower(coalesce(a.search_text,'')), p.ql) > 0 then
          substring(coalesce(a.search_text,'') from greatest(strpos(lower(coalesce(a.search_text,'')), p.ql)-50,1) for 190)
        else
          left(coalesce(a.search_text,''), 190)
      end as snippet,
      ('article.html?id=' || a.id::text) as url,
      coalesce(a.published_at, a.created_at) as created_at,
      (
        greatest(
          similarity(coalesce(a.title,''), p.q),
          similarity(coalesce(a.summary,''), p.q) * 0.90,
          similarity(coalesce(array_to_string(a.tags,' '),''), p.q) * 0.60
        )
        + case when a.title ilike (p.q || '%') then 0.35 else 0 end
        + case when a.title ilike ('%' || p.q || '%') then 0.15 else 0 end
      )::real as score,
      jsonb_build_object(
        'tags', a.tags,
        'cover_url', a.cover_url
      ) as extra
    from public.articles a, p
    where p.q <> ''
      and (p.types is null or 'article' = any(p.types))
      and a.search_text is not null
      and (
        a.search_text ilike ('%' || p.q || '%')
        or a.title % p.q
        or a.summary % p.q
      )
    order by score desc, created_at desc
    limit 120
  ),

  cases as (
    select
      'case'::text as type,
      c.id::text as id,
      c.title as title,
      case
        when p.ql <> '' and strpos(lower(coalesce(c.search_text,'')), p.ql) > 0 then
          substring(coalesce(c.search_text,'') from greatest(strpos(lower(coalesce(c.search_text,'')), p.ql)-50,1) for 190)
        else
          left(coalesce(c.search_text,''), 190)
      end as snippet,
      ('case.html?id=' || c.id::text) as url,
      c.created_at as created_at,
      (
        greatest(
          similarity(coalesce(c.title,''), p.q),
          similarity(coalesce(c.summary,''), p.q) * 0.85,
          similarity(coalesce(array_to_string(c.tags,' '),''), p.q) * 0.60
        )
        + case when c.title ilike (p.q || '%') then 0.30 else 0 end
        + case when c.title ilike ('%' || p.q || '%') then 0.12 else 0 end
      )::real as score,
      jsonb_build_object(
        'board', c.board,
        'tags', c.tags,
        'like_count', c.like_count,
        'comment_count', c.comment_count
      ) as extra
    from public.cases c, p
    where p.q <> ''
      and (p.types is null or 'case' = any(p.types))
      and c.deleted_at is null
      and c.search_text is not null
      and (
        c.search_text ilike ('%' || p.q || '%')
        or c.title % p.q
        or c.summary % p.q
      )
    order by score desc, created_at desc
    limit 120
  ),

  moments as (
    select
      'moment'::text as type,
      m.id::text as id,
      coalesce(nullif(left(coalesce(m.content,''), 60), ''), '动态') as title,
      case
        when p.ql <> '' and strpos(lower(coalesce(m.search_text,'')), p.ql) > 0 then
          substring(coalesce(m.search_text,'') from greatest(strpos(lower(coalesce(m.search_text,'')), p.ql)-50,1) for 190)
        else
          left(coalesce(m.search_text,''), 190)
      end as snippet,
      ('moments.html?id=' || m.id::text) as url,
      m.created_at as created_at,
      (
        greatest(
          similarity(coalesce(m.content,''), p.q),
          similarity(coalesce(m.author_name,''), p.q) * 0.65
        )
      )::real as score,
      jsonb_build_object(
        'author_name', m.author_name,
        'like_count', m.like_count,
        'comment_count', m.comment_count,
        'has_media', (array_length(m.images,1) is not null or m.video_url is not null)
      ) as extra
    from public.moments m, p
    where p.q <> ''
      and (p.types is null or 'moment' = any(p.types))
      and m.deleted_at is null
      and m.search_text is not null
      and (
        m.search_text ilike ('%' || p.q || '%')
        or m.content % p.q
        or m.author_name % p.q
      )
    order by score desc, created_at desc
    limit 120
  ),

  events as (
    select
      'event'::text as type,
      e.id::text as id,
      coalesce(nullif(e.title_zh,''), e.title_en, '会议与活动') as title,
      case
        when p.ql <> '' and strpos(lower(coalesce(e.search_text,'')), p.ql) > 0 then
          substring(coalesce(e.search_text,'') from greatest(strpos(lower(coalesce(e.search_text,'')), p.ql)-50,1) for 190)
        else
          left(coalesce(e.search_text,''), 190)
      end as snippet,
      'events.html' as url,
      coalesce(e.next_time, e.updated_at, e.created_at) as created_at,
      (
        greatest(
          similarity(coalesce(e.title_zh,''), p.q),
          similarity(coalesce(e.title_en,''), p.q) * 0.85,
          similarity(coalesce(e.description,''), p.q) * 0.75,
          similarity(coalesce(e.speaker_name,''), p.q) * 0.70
        )
      )::real as score,
      jsonb_build_object(
        'status', e.status,
        'next_time', e.next_time,
        'speaker_name', e.speaker_name
      ) as extra
    from public.event_series e, p
    where p.q <> ''
      and (p.types is null or 'event' = any(p.types))
      and e.search_text is not null
      and (
        e.search_text ilike ('%' || p.q || '%')
        or e.title_zh % p.q
        or e.title_en % p.q
      )
    order by score desc, created_at desc
    limit 120
  ),

  research as (
    select
      'research'::text as type,
      rp.id::text as id,
      rp.title as title,
      case
        when p.ql <> '' and strpos(lower(coalesce(rp.search_text,'')), p.ql) > 0 then
          substring(coalesce(rp.search_text,'') from greatest(strpos(lower(coalesce(rp.search_text,'')), p.ql)-50,1) for 190)
        else
          left(coalesce(rp.search_text,''), 190)
      end as snippet,
      'research.html' as url,
      rp.created_at as created_at,
      (
        greatest(
          similarity(coalesce(rp.title,''), p.q),
          similarity(coalesce(rp.summary,''), p.q) * 0.80,
          similarity(coalesce(rp.pi,''), p.q) * 0.70
        )
      )::real as score,
      jsonb_build_object(
        'status', rp.status,
        'pi', rp.pi
      ) as extra
    from public.research_projects rp, p
    where p.q <> ''
      and (p.types is null or 'research' = any(p.types))
      and rp.active = true
      and rp.search_text is not null
      and (
        rp.search_text ilike ('%' || p.q || '%')
        or rp.title % p.q
        or rp.summary % p.q
      )
    order by score desc, created_at desc
    limit 120
  ),

  people as (
    select
      'person'::text as type,
      s.id::text as id,
      s.title as title,
      case
        when p.ql <> '' and strpos(lower(coalesce(s.search_text,'')), p.ql) > 0 then
          substring(coalesce(s.search_text,'') from greatest(strpos(lower(coalesce(s.search_text,'')), p.ql)-50,1) for 190)
        else
          left(coalesce(s.search_text,''), 190)
      end as snippet,
      case
        when lower(coalesce(s.category,'')) = 'experts' then 'experts.html'
        when lower(coalesce(s.category,'')) = 'partners' then 'partners.html'
        when lower(coalesce(s.category,'')) = 'flagship' then 'flagship.html'
        else 'about.html'
      end as url,
      s.created_at as created_at,
      (
        greatest(
          similarity(coalesce(s.title,''), p.q),
          similarity(coalesce(s.description,''), p.q) * 0.80
        )
      )::real as score,
      jsonb_build_object(
        'category', s.category,
        'image_url', s.image_url,
        'link', s.link
      ) as extra
    from public.about_showcase s, p
    where p.q <> ''
      and (p.types is null or 'person' = any(p.types))
      and s.search_text is not null
      and (
        s.search_text ilike ('%' || p.q || '%')
        or s.title % p.q
        or s.description % p.q
      )
    order by score desc, created_at desc
    limit 120
  )

  select u.*
  from (
    select * from articles
    union all select * from cases
    union all select * from moments
    union all select * from events
    union all select * from research
    union all select * from people
  ) u, p
  order by u.score desc nulls last, u.created_at desc nulls last
  limit (select lim from p)
  offset (select off from p);
$$;
