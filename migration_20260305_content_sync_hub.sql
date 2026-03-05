begin;

create extension if not exists pgcrypto;

create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  legacy_article_id uuid unique,
  type text not null default 'article' check (type in ('article','topic')),
  title_zh text not null,
  title_en text,
  summary_zh text,
  tags text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft','in_review','published','archived')),
  paywall text not null default 'free_preview' check (paywall in ('free_preview','members_only')),
  author_name text,
  last_published_version_id uuid,
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  search_text text not null default ''
);

create table if not exists public.content_versions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content_items(id) on delete cascade,
  version text not null,
  status text not null default 'draft' check (status in ('draft','in_review','published','archived')),
  source_format text not null default 'html' check (source_format in ('html','markdown','blocks')),
  preview_body text not null default '',
  full_body text not null default '',
  toc_json jsonb,
  references_json jsonb,
  created_by uuid references auth.users(id),
  reviewed_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(content_id, version)
);

alter table public.content_items
  add constraint if not exists content_items_last_published_fk
  foreign key (last_published_version_id) references public.content_versions(id);

create table if not exists public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'expired' check (status in ('active','expired','canceled','past_due')),
  current_period_end timestamptz,
  plan_id text,
  provider text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_items_type_status_published_idx on public.content_items(type, status, published_at desc nulls last);
create index if not exists content_items_updated_idx on public.content_items(updated_at desc);
create index if not exists content_items_tags_idx on public.content_items using gin(tags);
create index if not exists content_versions_content_created_idx on public.content_versions(content_id, created_at desc);

create or replace function public.ks_update_timestamp()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_content_items_updated_at on public.content_items;
create trigger trg_content_items_updated_at
before update on public.content_items
for each row execute function public.ks_update_timestamp();

drop trigger if exists trg_memberships_updated_at on public.memberships;
create trigger trg_memberships_updated_at
before update on public.memberships
for each row execute function public.ks_update_timestamp();

create or replace function public.generate_content_preview(full_text text)
returns text language plpgsql immutable as $$
declare
  plain text := regexp_replace(coalesce(full_text,''), '<[^>]+>', '', 'g');
  short_text text;
begin
  plain := trim(regexp_replace(plain, '\s+', ' ', 'g'));
  if plain = '' then
    return '会员阅读全文';
  end if;
  if char_length(plain) <= 280 then
    return plain;
  end if;
  short_text := left(plain, 280);
  return short_text || '…\n\n—— 会员阅读全文 ——';
end;
$$;

create or replace function public.publish_content_version(p_content_id uuid, p_version_id uuid, p_actor uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.content_versions
  set status = 'published',
      approved_by = coalesce(p_actor, approved_by)
  where id = p_version_id
    and content_id = p_content_id;

  update public.content_items
  set status = 'published',
      last_published_version_id = p_version_id,
      published_at = now()
  where id = p_content_id;
end;
$$;

create or replace function public.refresh_content_search_text(p_content_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_title text;
  v_summary text;
  v_tags text;
  v_body text;
begin
  select title_zh, coalesce(summary_zh,''), array_to_string(tags,' ') into v_title, v_summary, v_tags
  from public.content_items where id = p_content_id;

  select regexp_replace(coalesce(full_body,''), '<[^>]+>', '', 'g')
  into v_body
  from public.content_versions
  where id = (select last_published_version_id from public.content_items where id = p_content_id);

  update public.content_items
  set search_text = trim(concat_ws(' ', coalesce(v_title,''), coalesce(v_summary,''), coalesce(v_tags,''), coalesce(v_body,'')))
  where id = p_content_id;
end;
$$;

-- bootstrap content hub from legacy published articles (idempotent)
insert into public.content_items (legacy_article_id, type, title_zh, summary_zh, tags, status, paywall, author_name, published_at)
select a.id, 'article', coalesce(a.title,'未命名'), a.summary, coalesce(a.tags,'{}'::text[]),
       case when a.status in ('draft','published','archived') then a.status else 'draft' end,
       'free_preview', a.author_name, a.published_at
from public.articles a
left join public.content_items ci on ci.legacy_article_id = a.id
where ci.id is null;

insert into public.content_versions (content_id, version, status, source_format, preview_body, full_body, created_by, created_at)
select ci.id,
       concat('legacy-', to_char(coalesce(a.updated_at, a.created_at, now()), 'YYYYMMDDHH24MISS')),
       case when a.status = 'published' then 'published' else 'draft' end,
       case when coalesce(a.content_html,'') <> '' then 'html' else 'markdown' end,
       public.generate_content_preview(coalesce(nullif(a.content_html,''), a.content_md, '')),
       coalesce(nullif(a.content_html,''), a.content_md, ''),
       a.author_id,
       coalesce(a.updated_at, a.created_at, now())
from public.articles a
join public.content_items ci on ci.legacy_article_id = a.id
left join public.content_versions cv on cv.content_id = ci.id
where cv.id is null;

update public.content_items ci
set last_published_version_id = cv.id
from public.content_versions cv
where ci.legacy_article_id is not null
  and cv.content_id = ci.id
  and cv.status = 'published'
  and (ci.last_published_version_id is null);

commit;
