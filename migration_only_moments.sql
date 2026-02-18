-- KidneySphere v4.x
-- Minimal migration: Moments tables + RLS + triggers
--
-- Use this when you see:
--   "Could not find the table 'public.moments' in the schema cache"
--
-- Preferred: run the full SUPABASE_SETUP.sql (idempotent) to ensure all tables exist.
-- If you only want to add Moments-related tables, run this file.
--
-- After running:
-- 1) Supabase Dashboard → Settings → API → click "Reload schema"
-- 2) Wait ~1 minute, refresh the website, try posting again.

-- ------------------------------
-- 0) Minimal profile helpers (needed by Moments RLS + points triggers)
-- ------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'member',
  avatar_url text,
  membership_status text not null default 'none',
  points integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists membership_status text not null default 'none';
alter table public.profiles add column if not exists points integer not null default 0;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

alter table public.profiles enable row level security;

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

-- Minimal policies for profiles (safe to re-run)
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_write_admin on public.profiles;

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

create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

-- ------------------------------
-- 1) Moments
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

alter table public.moments add column if not exists images text[] not null default '{}';
alter table public.moments add column if not exists video_url text;
alter table public.moments add column if not exists like_count integer not null default 0;
alter table public.moments add column if not exists comment_count integer not null default 0;
alter table public.moments add column if not exists deleted_at timestamptz;

alter table public.moments enable row level security;

-- Policies (drop then create)
drop policy if exists moments_select_public on public.moments;
drop policy if exists moments_select_admin on public.moments;
drop policy if exists moments_insert_own on public.moments;
drop policy if exists moments_update_own_or_admin on public.moments;
drop policy if exists moments_delete_admin on public.moments;

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

-- ------------------------------
-- 2) Moment likes
-- ------------------------------
create table if not exists public.moment_likes (
  moment_id bigint not null references public.moments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (moment_id, user_id)
);

alter table public.moment_likes enable row level security;

-- Policies

drop policy if exists moment_likes_select_own on public.moment_likes;
drop policy if exists moment_likes_insert_own on public.moment_likes;
drop policy if exists moment_likes_delete_own on public.moment_likes;

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

-- Triggers to maintain like_count + quality points
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
-- 3) Storage: Moments images bucket + policies
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


-- Done.
