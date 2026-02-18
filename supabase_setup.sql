-- KidneySphere Phase 1 (Full) · Supabase SQL Setup
-- Run this in Supabase SQL Editor.
-- Idempotent (safe to re-run). It creates/updates the tables + RLS policies used by the site.

-- ------------------------------
-- 1) Profiles (user roles)
-- ------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'member', -- member / doctor_pending / doctor_verified / industry / admin / super_admin
  avatar_url text,
  membership_status text not null default 'none', -- none / member / vip (optional)
  points integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- v11: ensure new columns exist for older deployments
alter table public.profiles add column if not exists membership_status text not null default 'none';
alter table public.profiles add column if not exists points integer not null default 0;

alter table public.profiles enable row level security;

-- Admin check helper
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role,'')) in ('super_admin','admin','owner')
  );
$$;

-- Protect sensitive profile fields from self-escalation
create or replace function public.profiles_protect_sensitive_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only allow normal users to update non-sensitive fields (full_name / avatar_url).
  -- Keep role/points/membership immutable unless admin.
  -- Only apply protection for direct client updates (DB role: authenticated/anon).
  -- Internal SECURITY DEFINER maintenance functions run as a different DB role.
  if current_user in ('authenticated','anon')
     and auth.uid() = old.id
     and not public.is_admin() then
    new.role := old.role;
    new.points := old.points;
    new.membership_status := old.membership_status;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_protect on public.profiles;
create trigger trg_profiles_protect
before update on public.profiles
for each row execute function public.profiles_protect_sensitive_fields();

-- v11: points helper (maintained via DB triggers)
create or replace function public.add_user_points(uid uuid, delta integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set points = greatest(points + delta, 0),
      updated_at = now()
  where id = uid;
end;
$$;

-- Drop existing policies for our tables (so RLS does not accumulate OR-ed rules)
do $$
declare pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'profiles',
        'channels','sections',
        'cases','case_comments',
        'case_likes',
        'moments','moment_likes',
        'frontier_modules','frontier_cards','sponsors',
        'about_showcase',
        'event_series','event_links',
        'research_projects'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

-- Profiles policies
create policy profiles_select_own
on public.profiles
for select
to authenticated
using (id = auth.uid());

create policy profiles_select_admin
on public.profiles
for select
to authenticated
using (public.is_admin());

create policy profiles_insert_own
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy profiles_update_own
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy profiles_update_admin
on public.profiles
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Optional: auto-create profile on signup (safe even if front-end also upserts)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'on_auth_user_created'
  ) then
    create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();
  end if;
end $$;

-- ------------------------------
-- 2) Community taxonomy: channels + sections
-- ------------------------------
create table if not exists public.channels (
  id text primary key,
  title_zh text not null,
  title_en text,
  description text,
  status text not null default 'active', -- active / coming_soon / hidden
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.sections (
  id bigserial primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  key text not null,
  title_zh text not null,
  title_en text,
  description text,
  status text not null default 'active',
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique(channel_id, key)
);

alter table public.channels enable row level security;
alter table public.sections enable row level security;

create policy channels_select_active
on public.channels
for select
to anon, authenticated
using (status = 'active' or status = 'coming_soon');

create policy sections_select_active
on public.sections
for select
to anon, authenticated
using (status = 'active');

create policy channels_write_admin
on public.channels
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy sections_write_admin
on public.sections
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Seed default channel + 5 communities (upsert)
insert into public.channels (id, title_zh, title_en, description, status, sort)
values
  ('case','核心社区','Communities','五大核心社区入口：病例、讨论、文献与研究内容将逐步统一沉淀。','active',0),
  ('research','科研讨论','Research','（筹备中）未来用于临床/基础研究讨论与协作。','coming_soon',10),
  ('english','英语讨论','English','（筹备中）英文病例/文献交流。','coming_soon',20)
on conflict (id) do update set
  title_zh = excluded.title_zh,
  title_en = excluded.title_en,
  description = excluded.description,
  status = excluded.status,
  sort = excluded.sort;

insert into public.sections (channel_id, key, title_zh, description, status, sort)
values
  ('case','glom','肾小球与间质性肾病社区','IgAN、MN、FSGS、MCD、AAV、补体相关病、间质性肾炎/药物相关肾损伤等。','active',0),
  ('case','tx','肾移植内科社区','排斥、感染、免疫抑制、妊娠、围手术期与长期随访。','active',10),
  ('case','icu','重症肾内（电解质/酸碱）与透析社区','AKI/CRRT、休克、液体管理与抗凝、电解质/酸碱紊乱、透析并发症。','active',20),
  ('case','peds','儿童肾脏病社区','儿肾病例、遗传肾病、儿童透析与移植随访、发育相关问题。','active',30),
  ('case','rare','罕见肾脏病社区','遗传/罕见肾病、C3G/aHUS、MGRS、Fabry 等疑难病例与机制讨论。','active',40)
on conflict (channel_id, key) do update set
  title_zh = excluded.title_zh,
  description = excluded.description,
  status = excluded.status,
  sort = excluded.sort;

-- ------------------------------
-- 3) Cases (posts) + Comments (replies)
-- ------------------------------
create table if not exists public.cases (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  board text not null, -- section key: glom/tx/icu/peds/rare/...
  title text not null,
  summary text,
  content text, -- reserved for future structured content
  tags text[] not null default '{}',
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  deleted_at timestamptz
);


-- Performance indexes
create index if not exists idx_cases_board_created_at_live
on public.cases(board, created_at desc)
where deleted_at is null;

create index if not exists idx_cases_created_at_live
on public.cases(created_at desc)
where deleted_at is null;

-- v11: ensure new column exists for older deployments
alter table public.cases add column if not exists like_count integer not null default 0;
alter table public.cases add column if not exists comment_count integer not null default 0;

alter table public.cases enable row level security;

create policy cases_select_authed
on public.cases
for select
to authenticated
using (deleted_at is null);

create policy cases_insert_authed
on public.cases
for insert
to authenticated
with check (auth.uid() = author_id);

create policy cases_update_author_or_admin
on public.cases
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

create policy cases_delete_admin
on public.cases
for delete
to authenticated
using (public.is_admin());

-- v11: protect derived fields (like_count) from direct client tampering
create or replace function public.cases_protect_derived_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_user in ('authenticated','anon') and not public.is_admin() then
    new.like_count := old.like_count;
    if to_jsonb(old) ? 'comment_count' then
      new.comment_count := old.comment_count;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cases_protect_derived on public.cases;
create trigger trg_cases_protect_derived
before update on public.cases
for each row execute function public.cases_protect_derived_fields();

-- v11: award points for new case posts (数量)
create or replace function public.trg_case_insert_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.add_user_points(new.author_id, 3);
  return new;
end;
$$;

drop trigger if exists trg_case_insert_points on public.cases;
create trigger trg_case_insert_points
after insert on public.cases
for each row execute function public.trg_case_insert_points();

-- v11: case likes (质量)
create table if not exists public.case_likes (
  case_id bigint not null references public.cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (case_id, user_id)
);

alter table public.case_likes enable row level security;

create policy case_likes_select_own
on public.case_likes
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy case_likes_insert_own
on public.case_likes
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.cases c
    where c.id = case_id and c.deleted_at is null
  )
);

create policy case_likes_delete_own
on public.case_likes
for delete
to authenticated
using (user_id = auth.uid() or public.is_admin());

create or replace function public.trg_case_like_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare owner_id uuid;
begin
  select c.author_id into owner_id
  from public.cases c
  where c.id = new.case_id;

  update public.cases
  set like_count = like_count + 1
  where id = new.case_id;

  if owner_id is not null then
    perform public.add_user_points(owner_id, 1);
  end if;
  return new;
end;
$$;

create or replace function public.trg_case_like_revert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare owner_id uuid;
begin
  select c.author_id into owner_id
  from public.cases c
  where c.id = old.case_id;

  update public.cases
  set like_count = greatest(like_count - 1, 0)
  where id = old.case_id;

  if owner_id is not null then
    perform public.add_user_points(owner_id, -1);
  end if;
  return old;
end;
$$;

drop trigger if exists trg_case_like_apply on public.case_likes;
create trigger trg_case_like_apply
after insert on public.case_likes
for each row execute function public.trg_case_like_apply();

drop trigger if exists trg_case_like_revert on public.case_likes;
create trigger trg_case_like_revert
after delete on public.case_likes
for each row execute function public.trg_case_like_revert();

create table if not exists public.case_comments (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  case_id bigint not null references public.cases(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text,
  body text not null,
  deleted_at timestamptz
);


-- Performance indexes
create index if not exists idx_case_comments_case_created_at_live
on public.case_comments(case_id, created_at)
where deleted_at is null;

alter table public.case_comments enable row level security;

create policy comments_select_authed
on public.case_comments
for select
to authenticated
using (
  deleted_at is null
  and exists (
    select 1 from public.cases c
    where c.id = case_id and c.deleted_at is null
  )
);

create policy comments_insert_authed
on public.case_comments
for insert
to authenticated
with check (
  auth.uid() = author_id
  and exists (
    select 1 from public.cases c
    where c.id = case_id and c.deleted_at is null
  )
);

create policy comments_update_author_or_admin
on public.case_comments
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

create policy comments_delete_admin
on public.case_comments
for delete
to authenticated
using (public.is_admin());

-- v11: award points for new comments (数量)
create or replace function public.trg_case_comment_insert_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.add_user_points(new.author_id, 1);
  return new;
end;
$$;

drop trigger if exists trg_case_comment_insert_points on public.case_comments;
create trigger trg_case_comment_insert_points
after insert on public.case_comments
for each row execute function public.trg_case_comment_insert_points();


-- v11+: keep cases.comment_count in sync with case_comments (supports soft-delete via deleted_at)
create or replace function public.recompute_case_comment_count(_case_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  update public.cases c
  set comment_count = (
    select count(1)
    from public.case_comments cc
    where cc.case_id = c.id and cc.deleted_at is null
  )
  where c.id = _case_id;
end;
$$;

create or replace function public.trg_case_comment_count()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if (TG_OP = 'INSERT') then
    perform public.recompute_case_comment_count(new.case_id);
  elsif (TG_OP = 'UPDATE') then
    perform public.recompute_case_comment_count(coalesce(new.case_id, old.case_id));
    if new.case_id is distinct from old.case_id then
      perform public.recompute_case_comment_count(old.case_id);
    end if;
  else
    perform public.recompute_case_comment_count(old.case_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_case_comment_count on public.case_comments;
create trigger trg_case_comment_count
after insert or update or delete on public.case_comments
for each row execute function public.trg_case_comment_count();


-- ------------------------------
-- vX) Safe soft-delete RPCs (avoid RLS edge cases on clients)
-- ------------------------------
-- delete_case: author or admin can soft-delete a case (and its comments)
create or replace function public.delete_case(_case_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  owner uuid;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select c.author_id into owner
  from public.cases c
  where c.id = _case_id;

  if owner is null then
    raise exception 'case not found';
  end if;

  if not (public.is_admin() or owner = uid) then
    raise exception 'not allowed';
  end if;

  update public.cases
    set deleted_at = now()
  where id = _case_id;

  -- also soft-delete its comments
  update public.case_comments
    set deleted_at = now()
  where case_id = _case_id and deleted_at is null;
end;
$$;

grant execute on function public.delete_case(bigint) to authenticated;

-- delete_case_comment: comment author OR case author OR admin can soft-delete a comment
create or replace function public.delete_case_comment(_comment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  c_author uuid;
  c_case_id bigint;
  case_author uuid;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select cc.author_id, cc.case_id
    into c_author, c_case_id
  from public.case_comments cc
  where cc.id = _comment_id;

  if c_author is null then
    raise exception 'comment not found';
  end if;

  select c.author_id into case_author
  from public.cases c
  where c.id = c_case_id;

  if not (public.is_admin() or c_author = uid or case_author = uid) then
    raise exception 'not allowed';
  end if;

  update public.case_comments
    set deleted_at = now()
  where id = _comment_id;
end;
$$;

grant execute on function public.delete_case_comment(bigint) to authenticated;


-- ------------------------------
-- 4) About showcase: Flagship / Partners / Experts
-- ------------------------------
create table if not exists public.about_showcase (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  category text not null, -- flagship / partners / experts
  title text not null,
  description text,
  link text,
  image_url text,
  sort int not null default 0
);

alter table public.about_showcase enable row level security;

create policy about_showcase_select_all
on public.about_showcase
for select
to anon, authenticated
using (true);

create policy about_showcase_write_admin
on public.about_showcase
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- ------------------------------
-- 4b) Moments: fast community feed (text + images + short video)
-- ------------------------------
create table if not exists public.moments (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text,
  content text,
  images text[] not null default '{}',
  video_url text,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  deleted_at timestamptz
);


-- Performance index
create index if not exists idx_moments_created_at_live
on public.moments(created_at desc)
where deleted_at is null;

-- v11: ensure columns exist for older deployments
alter table public.moments add column if not exists images text[] not null default '{}';
alter table public.moments add column if not exists video_url text;
alter table public.moments add column if not exists like_count integer not null default 0;
alter table public.moments add column if not exists comment_count integer not null default 0;
alter table public.moments add column if not exists deleted_at timestamptz;

alter table public.moments enable row level security;

create policy moments_select_public
on public.moments
for select
to anon, authenticated
using (deleted_at is null);

create policy moments_select_admin
on public.moments
for select
to authenticated
using (public.is_admin());

create policy moments_insert_own
on public.moments
for insert
to authenticated
with check (auth.uid() = author_id);

create policy moments_update_own_or_admin
on public.moments
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

-- delete_moment: moment author or admin can soft-delete a moment
create or replace function public.delete_moment(_moment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  owner uuid;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select m.author_id into owner
  from public.moments m
  where m.id = _moment_id;

  if owner is null then
    raise exception 'moment not found';
  end if;

  if not (public.is_admin() or owner = uid) then
    raise exception 'not allowed';
  end if;

  update public.moments
    set deleted_at = now()
  where id = _moment_id;
end;
$$;

grant execute on function public.delete_moment(bigint) to authenticated;


create policy moments_delete_admin
on public.moments
for delete
to authenticated
using (public.is_admin());

-- protect derived like_count from direct client tampering
create or replace function public.moments_protect_derived_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_user in ('authenticated','anon') and not public.is_admin() then
    new.like_count := old.like_count;
    if to_jsonb(old) ? 'comment_count' then
      new.comment_count := old.comment_count;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_moments_protect_derived on public.moments;
create trigger trg_moments_protect_derived
before update on public.moments
for each row execute function public.moments_protect_derived_fields();

-- award points for new moments (数量)
create or replace function public.trg_moment_insert_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.add_user_points(new.author_id, 1);
  return new;
end;
$$;

drop trigger if exists trg_moment_insert_points on public.moments;
create trigger trg_moment_insert_points
after insert on public.moments
for each row execute function public.trg_moment_insert_points();

-- Likes for moments (质量)
create table if not exists public.moment_likes (
  moment_id bigint not null references public.moments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (moment_id, user_id)
);

alter table public.moment_likes enable row level security;

create policy moment_likes_select_own
on public.moment_likes
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy moment_likes_insert_own
on public.moment_likes
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.moments m
    where m.id = moment_id and m.deleted_at is null
  )
);

create policy moment_likes_delete_own
on public.moment_likes
for delete
to authenticated
using (user_id = auth.uid() or public.is_admin());

create or replace function public.trg_moment_like_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare owner_id uuid;
begin
  select m.author_id into owner_id
  from public.moments m
  where m.id = new.moment_id;

  update public.moments
  set like_count = like_count + 1
  where id = new.moment_id;

  if owner_id is not null then
    perform public.add_user_points(owner_id, 1);
  end if;
  return new;
end;
$$;

create or replace function public.trg_moment_like_revert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare owner_id uuid;
begin
  select m.author_id into owner_id
  from public.moments m
  where m.id = old.moment_id;

  update public.moments
  set like_count = greatest(like_count - 1, 0)
  where id = old.moment_id;

  if owner_id is not null then
    perform public.add_user_points(owner_id, -1);
  end if;
  return old;
end;
$$;

drop trigger if exists trg_moment_like_apply on public.moment_likes;
create trigger trg_moment_like_apply
after insert on public.moment_likes
for each row execute function public.trg_moment_like_apply();

drop trigger if exists trg_moment_like_revert on public.moment_likes;
create trigger trg_moment_like_revert
after delete on public.moment_likes
for each row execute function public.trg_moment_like_revert();

-- ------------------------------
-- 4c) Frontier: modular blocks + sponsors (admin-managed)
-- ------------------------------

-- ------------------------------
-- Moment comments (留言/回复)
-- ------------------------------
create table if not exists public.moment_comments (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  moment_id bigint not null references public.moments(id) on delete cascade,
  parent_id bigint references public.moment_comments(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text,
  body text not null,
  deleted_at timestamptz
);

create index if not exists idx_moment_comments_moment_id on public.moment_comments(moment_id);
create index if not exists idx_moment_comments_parent_id on public.moment_comments(parent_id);

alter table public.moment_comments enable row level security;

create policy moment_comments_select_public
on public.moment_comments
for select
to anon, authenticated
using (deleted_at is null);

create policy moment_comments_select_admin
on public.moment_comments
for select
to authenticated
using (public.is_admin());

create policy moment_comments_insert_own
on public.moment_comments
for insert
to authenticated
with check (auth.uid() = author_id);

-- Allow comment author OR moment author OR admin to soft-delete/update their comment
create policy moment_comments_update_owner_or_moment_author_or_admin
on public.moment_comments
for update
to authenticated
using (
  auth.uid() = author_id
  or public.is_admin()
  or exists (
    select 1 from public.moments m
    where m.id = moment_id and m.author_id = auth.uid()
  )
)
with check (
  auth.uid() = author_id
  or public.is_admin()
  or exists (
    select 1 from public.moments m
    where m.id = moment_id and m.author_id = auth.uid()
  )
);

-- Maintain moments.comment_count (denormalized)
create or replace function public.recompute_moment_comment_count(_moment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.moments
  set comment_count = (
    select count(*)::int from public.moment_comments c
    where c.moment_id = _moment_id and c.deleted_at is null
  )
  where id = _moment_id;
end;
$$;

create or replace function public.trg_moment_comments_recount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    perform public.recompute_moment_comment_count(new.moment_id);
  elsif (tg_op = 'UPDATE') then
    perform public.recompute_moment_comment_count(coalesce(new.moment_id, old.moment_id));
  elsif (tg_op = 'DELETE') then
    perform public.recompute_moment_comment_count(old.moment_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_moment_comments_recount_iud on public.moment_comments;
create trigger trg_moment_comments_recount_iud
after insert or update or delete on public.moment_comments
for each row execute function public.trg_moment_comments_recount();

-- RPC: add comment (robust against RLS pitfalls)
create or replace function public.add_moment_comment(
  _moment_id bigint,
  _body text,
  _parent_id bigint default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  nm text;
  cid bigint;
  parent_moment bigint;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if _body is null or length(trim(_body)) = 0 then
    raise exception 'empty body';
  end if;

  if not exists (select 1 from public.moments m where m.id = _moment_id and m.deleted_at is null) then
    raise exception 'moment not found';
  end if;

  if _parent_id is not null then
    select c.moment_id into parent_moment
    from public.moment_comments c
    where c.id = _parent_id and c.deleted_at is null;

    if parent_moment is null then
      raise exception 'parent comment not found';
    end if;
    if parent_moment <> _moment_id then
      raise exception 'parent mismatch';
    end if;
  end if;

  select nullif(trim(p.full_name), '') into nm
  from public.profiles p
  where p.id = uid;

  if nm is null then
    nm := '成员';
  end if;

  insert into public.moment_comments(moment_id, parent_id, author_id, author_name, body, deleted_at)
  values (_moment_id, _parent_id, uid, nm, trim(_body), null)
  returning id into cid;

  return cid;
end;
$$;

-- RPC: soft delete comment (comment author OR moment author OR admin)
create or replace function public.delete_moment_comment(_comment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  owner uuid;
  mid bigint;
  moment_owner uuid;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select c.author_id, c.moment_id into owner, mid
  from public.moment_comments c
  where c.id = _comment_id;

  if owner is null then
    raise exception 'comment not found';
  end if;

  select m.author_id into moment_owner
  from public.moments m
  where m.id = mid;

  if not (uid = owner or public.is_admin() or uid = moment_owner) then
    raise exception 'not allowed';
  end if;

  update public.moment_comments
  set deleted_at = now()
  where id = _comment_id and deleted_at is null;
end;
$$;

-- ------------------------------
-- Attachments (通用附件：图片/PDF/Word 等)
-- target_type: 'moment_comment' | 'case_comment' | ...
-- ------------------------------
create table if not exists public.attachments (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  target_type text not null,
  target_id bigint not null,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text,
  bucket text not null default 'attachments',
  path text not null,
  public_url text,
  mime_type text,
  original_name text,
  size_bytes bigint,
  kind text not null default 'file', -- image/pdf/doc/file
  deleted_at timestamptz
);

create index if not exists idx_attachments_target on public.attachments(target_type, target_id);
create index if not exists idx_attachments_author on public.attachments(author_id);

alter table public.attachments enable row level security;

-- Clean up legacy policy names (older builds used anon+authenticated read)
drop policy if exists attachments_select_public on public.attachments;
drop policy if exists attachments_select_authed on public.attachments;

-- Public read for site-wide content (e.g. Expert PPT library)
drop policy if exists attachments_select_public_expert_ppt on public.attachments;
create policy attachments_select_public_expert_ppt
on public.attachments
for select
to anon, authenticated
using (deleted_at is null and target_type = 'expert_ppt');

-- v12: allow public read of moment attachments stored in the public "moments" bucket
drop policy if exists attachments_select_public_moment_files on public.attachments;
create policy attachments_select_public_moment_files
on public.attachments
for select
to anon, authenticated
using (deleted_at is null and target_type = 'moment' and bucket = 'moments');

-- Authenticated read for everything else (attachments are sensitive; files are served via signed URLs)
drop policy if exists attachments_select_authed_private on public.attachments;
create policy attachments_select_authed_private
on public.attachments
for select
to authenticated
using (deleted_at is null and target_type <> 'expert_ppt');

-- Insert only by self
create policy attachments_insert_own
on public.attachments
for insert
to authenticated
with check (auth.uid() = author_id);

-- Soft delete/update by uploader or admin
create policy attachments_update_owner_or_admin
on public.attachments
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());


-- ------------------------------
-- Research center settings (single-row config)
-- ------------------------------
create table if not exists public.research_settings (
  id int primary key,
  intro text,
  contact text,
  address text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  -- Speaker info (public)
  speaker_name text,
  speaker_title text,
  speaker_bio text
);

insert into public.research_settings(id)
values (1)
on conflict (id) do nothing;

alter table public.research_settings enable row level security;

create policy research_settings_select_public
on public.research_settings
for select
to anon, authenticated
using (true);

create policy research_settings_write_admin
on public.research_settings
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());



create table if not exists public.frontier_modules (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  title_zh text not null,
  description text,
  kind text not null default 'cards', -- cards / richtext / sponsors
  body text,
  enabled boolean not null default true,
  sort int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  -- Speaker info (public)
  speaker_name text,
  speaker_title text,
  speaker_bio text
);

alter table public.frontier_modules enable row level security;

create policy frontier_modules_select_public
on public.frontier_modules
for select
to anon, authenticated
using (enabled = true);

create policy frontier_modules_select_admin
on public.frontier_modules
for select
to authenticated
using (public.is_admin());

create policy frontier_modules_write_admin
on public.frontier_modules
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create table if not exists public.frontier_cards (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  module_id bigint not null references public.frontier_modules(id) on delete cascade,
  title text not null,
  summary text,
  image_url text,
  link_url text,
  enabled boolean not null default true,
  sort int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  -- Speaker info (public)
  speaker_name text,
  speaker_title text,
  speaker_bio text
);

alter table public.frontier_cards enable row level security;

create policy frontier_cards_select_public
on public.frontier_cards
for select
to anon, authenticated
using (enabled = true);

create policy frontier_cards_select_admin
on public.frontier_cards
for select
to authenticated
using (public.is_admin());

create policy frontier_cards_write_admin
on public.frontier_cards
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create table if not exists public.sponsors (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  name text not null,
  tier text not null default 'partner',
  logo_url text,
  description text,
  website text,
  enabled boolean not null default true,
  -- v4.1: whether to show on Home page sponsor wall
  show_on_home boolean not null default true,
  sort int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  -- Speaker info (public)
  speaker_name text,
  speaker_title text,
  speaker_bio text
);

-- v4.1: ensure column exists for older deployments
alter table public.sponsors add column if not exists show_on_home boolean not null default true;

alter table public.sponsors enable row level security;

create policy sponsors_select_public
on public.sponsors
for select
to anon, authenticated
using (enabled = true);

create policy sponsors_select_admin
on public.sponsors
for select
to authenticated
using (public.is_admin());

create policy sponsors_write_admin
on public.sponsors
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Updated meta helper (updated_at / updated_by)
create or replace function public.set_updated_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_frontier_modules_updated on public.frontier_modules;
create trigger trg_frontier_modules_updated
before insert or update on public.frontier_modules
for each row execute function public.set_updated_meta();

drop trigger if exists trg_frontier_cards_updated on public.frontier_cards;
create trigger trg_frontier_cards_updated
before insert or update on public.frontier_cards
for each row execute function public.set_updated_meta();

drop trigger if exists trg_sponsors_updated on public.sponsors;
create trigger trg_sponsors_updated
before insert or update on public.sponsors
for each row execute function public.set_updated_meta();

-- ------------------------------
-- 4d) Storage: Moments images bucket + policies
-- ------------------------------
-- Create a public bucket for Moments images.
-- (If you prefer signed URLs, set public=false and adjust frontend.)
insert into storage.buckets (id, name, public)
values ('moments', 'moments', true)
on conflict (id) do update set public = excluded.public;

-- Policies for storage.objects (bucket = 'moments')
drop policy if exists "moments_public_read" on storage.objects;
drop policy if exists "moments_insert_own" on storage.objects;
drop policy if exists "moments_delete_own_or_admin" on storage.objects;

create policy "moments_public_read"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'moments');

create policy "moments_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'moments'
  and (name like (auth.uid()::text || '/%'))
);

create policy "moments_delete_own_or_admin"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'moments'
  and ((name like (auth.uid()::text || '/%')) or public.is_admin())
);

drop policy if exists "moments_update_own" on storage.objects;
create policy "moments_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'moments'
  and (name like (auth.uid()::text || '/%'))
)
with check (
  bucket_id = 'moments'
  and (name like (auth.uid()::text || '/%'))
);


-- ------------------------------
-- 4e) Storage: Attachments bucket + policies
-- ------------------------------
-- Create a private bucket for discussion attachments (images / pdf / docx).
-- Files are served via short-lived signed URLs (frontend handles signing).
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "attachments_public_read" on storage.objects;
drop policy if exists "attachments_read_authed" on storage.objects;
drop policy if exists "attachments_insert_own" on storage.objects;
drop policy if exists "attachments_delete_own_or_admin" on storage.objects;
drop policy if exists "attachments_update_own" on storage.objects;

create policy "attachments_read_authed"
on storage.objects
for select
to authenticated
using (bucket_id = 'attachments');

create policy "attachments_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'attachments'
  and (name like (auth.uid()::text || '/%'))
);

create policy "attachments_delete_own_or_admin"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'attachments'
  and ((name like (auth.uid()::text || '/%')) or public.is_admin())
);

create policy "attachments_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'attachments'
  and (name like (auth.uid()::text || '/%'))
)
with check (
  bucket_id = 'attachments'
  and (name like (auth.uid()::text || '/%'))
);


-- ------------------------------
-- 5) Events: schedule (public) + links (members only when confirmed)
-- ------------------------------
create table if not exists public.event_series (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  key text unique,
  title_zh text not null,
  title_en text,
  platform text,
  description text,
  rule_zh text,
  status text not null default 'pending', -- pending / confirmed / rescheduled / canceled / planning
  next_time timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  -- Speaker info (public)
  speaker_name text,
  speaker_title text,
  speaker_bio text
);

alter table public.event_series enable row level security;

alter table public.event_series add column if not exists speaker_name text;
alter table public.event_series add column if not exists speaker_title text;
alter table public.event_series add column if not exists speaker_bio text;



drop trigger if exists trg_event_series_updated on public.event_series;
create trigger trg_event_series_updated
before insert or update on public.event_series
for each row execute function public.set_updated_meta();

create policy event_series_select_all
on public.event_series
for select
to anon, authenticated
using (true);

create policy event_series_write_admin
on public.event_series
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create table if not exists public.event_links (
  event_id bigint primary key references public.event_series(id) on delete cascade,
  join_url text,
  passcode text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.event_links enable row level security;

drop trigger if exists trg_event_links_updated on public.event_links;
create trigger trg_event_links_updated
before insert or update on public.event_links
for each row execute function public.set_updated_meta();

create policy event_links_select_confirmed_authed
on public.event_links
for select
to authenticated
using (
  exists (
    select 1 from public.event_series e
    where e.id = event_id
      and lower(e.status) = 'confirmed'
  )
);

create policy event_links_write_admin
on public.event_links
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Seed default events (upsert by key)
insert into public.event_series (key, title_zh, title_en, platform, description, rule_zh, status)
values
  ('sun_zoom','每周日 10:00（北京时间）','Weekly (Sun 10:00 CST)','Zoom','Zoom 学术会议：病例与前沿进展分享。','常规：每周日 10:00（北京时间）','pending'),
  ('wed_tencent','每周三 20:00（北京时间）','Weekly (Wed 20:00 CST)','腾讯会议','围绕指南/综述/临床试验的文献学习与讨论。','常规：每周三 20:00（北京时间）','pending'),
  ('biweekly_case','每两周一次 · 周四晚间（北京时间）','Biweekly (Thu evening CST)','线上会议','病例讨论专场（时间以通知为准）。','常规：每两周一次 周四晚间（北京时间）','pending'),
  ('peds_zoom','儿童肾脏病 Zoom 会议（筹备中）','Peds Zoom (Planning)','Zoom','儿童肾脏病与相关专题会议（筹备中）。','筹备中：后续公布时间','planning')
on conflict (key) do update set
  title_zh = excluded.title_zh,
  title_en = excluded.title_en,
  platform = excluded.platform,
  description = excluded.description,
  rule_zh = excluded.rule_zh,
  status = excluded.status;

-- ------------------------------
-- 6) Research projects (public list, admin write)
-- ------------------------------
create table if not exists public.research_projects (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  title text not null,
  status text not null default 'planning', -- planning/starting/recruiting/ongoing/completed
  study_type text,
  summary text,
  pi text,
  active boolean not null default true,
  sort_order int not null default 0
);

alter table public.research_projects enable row level security;

create policy research_select_active
on public.research_projects
for select
to anon, authenticated
using (active = true);

create policy research_write_admin
on public.research_projects
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Done.
