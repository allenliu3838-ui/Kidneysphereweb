-- KidneySphere Phase 1 (v7) incremental migration
-- Date: 2026-01-07
-- Adds:
-- 1) Articles module (articles table + RLS)
-- 2) Speaker avatars for events (event_series.speaker_avatar_url + speakers storage bucket + policies)
-- 3) Super-admin-only role assignment (is_super_admin + set_user_role + stricter trigger)

-- =========================================================
-- 0) Helpers
-- =========================================================

create or replace function public.is_super_admin()
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
      and lower(coalesce(p.role,'')) in ('super_admin','owner')
  );
$$;

-- Tighten profile updates: only super_admin can change role (even for other users).
create or replace function public.profiles_protect_sensitive_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only apply protection for direct client updates (DB role: authenticated/anon).
  if current_user in ('authenticated','anon') then
    -- Role can only be changed by super admins.
    if not public.is_super_admin() then
      new.role := old.role;
    end if;

    -- Self updates: normal members cannot escalate points/membership.
    if auth.uid() = old.id and not public.is_admin() then
      new.points := old.points;
      new.membership_status := old.membership_status;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- Super-admin-only role assignment API (used by roles.js).
create or replace function public.set_user_role(target_user uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
begin
  if not public.is_super_admin() then
    raise exception 'not authorized';
  end if;

  r := lower(coalesce(new_role, 'member'));
  if r not in ('member','admin','super_admin','owner') then
    raise exception 'invalid role: %', r;
  end if;

  update public.profiles
     set role = r,
         updated_at = now()
   where id = target_user;

  if not found then
    raise exception 'user profile not found';
  end if;
end;
$$;

revoke all on function public.set_user_role(uuid, text) from public;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- =========================================================
-- 1) Events: speaker avatar URL + storage bucket/policies
-- =========================================================

alter table public.event_series
  add column if not exists speaker_avatar_url text;

-- Storage bucket for speaker avatars (public read).
insert into storage.buckets (id, name, public)
values ('speakers', 'speakers', true)
on conflict (id) do nothing;

-- Public read
drop policy if exists "speakers_public_read" on storage.objects;
create policy "speakers_public_read"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'speakers');

-- Admin write
drop policy if exists "speakers_admin_insert" on storage.objects;
create policy "speakers_admin_insert"
on storage.objects for insert
to authenticated
with check (bucket_id = 'speakers' and public.is_admin());

drop policy if exists "speakers_admin_update" on storage.objects;
create policy "speakers_admin_update"
on storage.objects for update
to authenticated
using (bucket_id = 'speakers' and public.is_admin())
with check (bucket_id = 'speakers' and public.is_admin());

drop policy if exists "speakers_admin_delete" on storage.objects;
create policy "speakers_admin_delete"
on storage.objects for delete
to authenticated
using (bucket_id = 'speakers' and public.is_admin());

-- =========================================================
-- 2) Articles table + RLS
-- =========================================================

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text,
  content_md text not null default '',
  cover_url text,
  tags text[] not null default '{}',
  status text not null default 'draft',
  pinned boolean not null default false,

  author_id uuid references auth.users(id) on delete set null,
  author_name text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,

  published_at timestamptz,
  deleted_at timestamptz
);

-- Basic constraints
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'articles_status_check'
  ) then
    alter table public.articles
      add constraint articles_status_check
      check (status in ('draft','published','archived'));
  end if;
end$$;

create index if not exists idx_articles_status on public.articles(status);
create index if not exists idx_articles_published_at on public.articles(published_at desc);
create index if not exists idx_articles_updated_at on public.articles(updated_at desc);

-- Updated meta trigger
drop trigger if exists trg_articles_updated_meta on public.articles;
create trigger trg_articles_updated_meta
before insert or update on public.articles
for each row execute function public.set_updated_meta();

alter table public.articles enable row level security;

-- Public can read published (not deleted)
drop policy if exists "articles_public_read" on public.articles;
create policy "articles_public_read"
on public.articles for select
to anon, authenticated
using (status = 'published' and deleted_at is null);

-- Admin can read all
drop policy if exists "articles_admin_read_all" on public.articles;
create policy "articles_admin_read_all"
on public.articles for select
to authenticated
using (public.is_admin());

-- Admin write
drop policy if exists "articles_admin_insert" on public.articles;
create policy "articles_admin_insert"
on public.articles for insert
to authenticated
with check (public.is_admin());

drop policy if exists "articles_admin_update" on public.articles;
create policy "articles_admin_update"
on public.articles for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "articles_admin_delete" on public.articles;
create policy "articles_admin_delete"
on public.articles for delete
to authenticated
using (public.is_admin());

-- =========================================================
-- Done
-- =========================================================
