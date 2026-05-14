-- Atlas Pro v1 schema
create table if not exists public.atlas_categories (
  id bigserial primary key,
  name text not null,
  slug text unique not null,
  description text,
  parent_id bigint references public.atlas_categories(id) on delete set null,
  icon text,
  sort_order int default 0,
  status text not null default 'published' check (status in ('draft','published','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_topics (
  id bigserial primary key,
  category_id bigint not null references public.atlas_categories(id) on delete cascade,
  name text not null,
  slug text unique not null,
  summary text,
  cover_image_path text,
  status text not null default 'draft' check (status in ('draft','published','hidden')),
  is_featured boolean not null default false,
  sort_order int default 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_series (
  id bigserial primary key,
  topic_id bigint not null references public.atlas_topics(id) on delete cascade,
  title text not null,
  slug text unique not null,
  subtitle text,
  summary text,
  cover_image_path text,
  visibility text not null default 'pro' check (visibility in ('free','pro','hidden')),
  status text not null default 'draft' check (status in ('draft','published','archived')),
  review_status text not null default 'pending' check (review_status in ('pending','reviewed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  published_at timestamptz,
  sort_order int default 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_assets (
  id bigserial primary key,
  series_id bigint not null references public.atlas_series(id) on delete cascade,
  title text,
  sequence_no int not null default 1,
  image_path text,
  preview_image_path text,
  thumbnail_path text,
  alt_text text,
  caption text,
  quick_memory text,
  clinical_note text,
  visibility text not null default 'pro' check (visibility in ('free','pro','hidden')),
  is_preview boolean not null default false,
  copyright_status text not null default 'needs_review' check (copyright_status in ('original','licensed','needs_review')),
  deidentified_status text not null default 'needs_review' check (deidentified_status in ('not_applicable','confirmed','needs_review')),
  review_status text not null default 'pending' check (review_status in ('pending','reviewed')),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_references (
  id bigserial primary key,
  series_id bigint references public.atlas_series(id) on delete cascade,
  asset_id bigint references public.atlas_assets(id) on delete cascade,
  citation_text text not null,
  source_type text not null default 'paper' check (source_type in ('guideline','paper','book','website','other')),
  journal text,
  year int,
  doi text,
  pmid text,
  url text,
  sort_order int default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_favorites (
  id bigserial primary key,
  user_id uuid not null,
  series_id bigint references public.atlas_series(id) on delete cascade,
  asset_id bigint references public.atlas_assets(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.atlas_views (
  id bigserial primary key,
  user_id uuid,
  series_id bigint references public.atlas_series(id) on delete set null,
  asset_id bigint references public.atlas_assets(id) on delete set null,
  event_type text not null default 'view',
  created_at timestamptz not null default now()
);

alter table public.atlas_categories enable row level security;
alter table public.atlas_topics enable row level security;
alter table public.atlas_series enable row level security;
alter table public.atlas_assets enable row level security;
alter table public.atlas_references enable row level security;
alter table public.atlas_favorites enable row level security;
alter table public.atlas_views enable row level security;

drop policy if exists atlas_categories_public_read on public.atlas_categories;
drop policy if exists atlas_topics_public_read on public.atlas_topics;
drop policy if exists atlas_series_public_read on public.atlas_series;
drop policy if exists atlas_assets_public_read on public.atlas_assets;
drop policy if exists atlas_references_public_read on public.atlas_references;

create policy atlas_categories_public_read on public.atlas_categories for select using (status='published');
create policy atlas_topics_public_read on public.atlas_topics for select using (status='published');
create policy atlas_series_public_read on public.atlas_series for select using (status='published' and visibility <> 'hidden');
create policy atlas_assets_public_read on public.atlas_assets for select using (visibility in ('free') or is_preview = true);
create policy atlas_references_public_read on public.atlas_references for select using (true);

create index if not exists idx_atlas_topics_category on public.atlas_topics(category_id, sort_order);
create index if not exists idx_atlas_series_topic on public.atlas_series(topic_id, sort_order);
create index if not exists idx_atlas_assets_series on public.atlas_assets(series_id, sequence_no);

-- seed: categories + MVP topics (idempotent by slug)
insert into public.atlas_categories (name, slug, description, sort_order, status) values
('肾小球疾病与免疫肾病','glomerular-immunology','免疫相关肾小球疾病专题图谱',1,'published'),
('AKI 与重症肾内科','aki-critical-care-nephrology','重症肾脏病与AKI图谱',2,'published'),
('肾移植内科','kidney-transplant-nephrology','肾移植内科核心图谱',3,'published')
on conflict (slug) do nothing;

-- MVP topics seed (12)
insert into public.atlas_topics (category_id, name, slug, summary, status, is_featured, sort_order)
select c.id, v.name, v.slug, v.summary, 'published', true, v.sort_order
from (values
  ('glomerular-immunology','IgA 肾病','iga-nephropathy','IgA 肾病机制、病理与治疗路径',1),
  ('glomerular-immunology','膜性肾病','membranous-nephropathy','膜性肾病抗原、病理与风险分层',2),
  ('glomerular-immunology','狼疮性肾炎','lupus-nephritis','狼疮肾炎分型与治疗路径',3),
  ('glomerular-immunology','FSGS / 微小病变','fsgs-minimal-change','FSGS 与微小病变诊治图谱',4),
  ('glomerular-immunology','ANCA 相关肾炎 / 抗 GBM','anca-anti-gbm','ANCA 与抗GBM病诊疗框架',5),
  ('glomerular-immunology','C3G / MPGN','c3g-mpgn','补体介导肾炎识别与处理',6),
  ('glomerular-immunology','糖尿病肾病','diabetic-kidney-disease','糖尿病肾病风险分层与管理',7),
  ('glomerular-immunology','TMA / MGRS','tma-mgrs','TMA 与 MGRS 临床-病理关联',8),
  ('aki-critical-care-nephrology','脓毒症 AKI','sepsis-associated-aki','脓毒症AKI与肾灌注',9),
  ('aki-critical-care-nephrology','CRRT 处方与抗凝','crrt-prescription-anticoagulation','CRRT处方、抗凝与并发症',10),
  ('kidney-transplant-nephrology','肾移植排斥反应','transplant-rejection','TCMR 与 ABMR 核心图谱',11),
  ('kidney-transplant-nephrology','BK / CMV 与移植后感染','bk-cmv-post-transplant-infection','移植后病毒与感染管理',12)
) as v(category_slug,name,slug,summary,sort_order)
join public.atlas_categories c on c.slug=v.category_slug
on conflict (slug) do nothing;

-- sample series seed
insert into public.atlas_series (topic_id,title,slug,summary,visibility,status,review_status,sort_order,published_at)
select t.id, v.title, v.slug, v.summary, v.visibility, 'published', 'reviewed', v.sort_order, now()
from (values
  ('iga-nephropathy','IgA 肾病：从机制到治疗决策','iga-mechanism-to-therapy','IgA病理机制与治疗决策流程图谱','pro',1),
  ('membranous-nephropathy','膜性肾病：抗原、病理与风险分层','mn-antigen-pathology-risk','膜性肾病核心图谱','pro',2),
  ('sepsis-associated-aki','脓毒症中的肾灌注：从宏循环到微循环','sepsis-renal-perfusion-micro','重症AKI微循环图谱','free',3),
  ('transplant-rejection','肾移植排斥反应：TCMR 与 ABMR','transplant-tcmr-abmr','移植排斥反应速记图谱','pro',4)
) as v(topic_slug,title,slug,summary,visibility,sort_order)
join public.atlas_topics t on t.slug=v.topic_slug
on conflict (slug) do nothing;

-- enforce publish compliance for atlas_series
create or replace function public.validate_atlas_series_publish()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'published' then
    if exists (
      select 1 from public.atlas_assets a
      where a.series_id = new.id
        and (a.copyright_status = 'needs_review' or a.deidentified_status = 'needs_review')
    ) then
      raise exception 'Series cannot be published: contains assets with needs_review compliance status';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_atlas_series_publish on public.atlas_series;
create trigger trg_validate_atlas_series_publish
before insert or update on public.atlas_series
for each row execute function public.validate_atlas_series_publish();

-- storage buckets for atlas
insert into storage.buckets (id, name, public)
values ('atlas_previews','atlas_previews', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('atlas_hd','atlas_hd', false)
on conflict (id) do nothing;
