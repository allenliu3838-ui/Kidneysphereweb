-- ============================================================
-- Patch: Enable RLS on content_items, content_versions, memberships
-- and add admin permission check to publish_content_version().
--
-- Fixes: These tables were created in migration_20260305 without
-- RLS policies, leaving them unprotected for authenticated users.
-- ============================================================

begin;

-- ────────────────────────────────────────────────────────────
-- 1. content_items
-- ────────────────────────────────────────────────────────────
alter table public.content_items enable row level security;

-- Anyone can read published items (anonymous + authenticated)
create policy content_items_select_published
  on public.content_items for select
  using (status = 'published');

-- Admins can read all items (including drafts)
create policy content_items_select_admin
  on public.content_items for select to authenticated
  using (public.is_admin());

-- Only admins can insert / update / delete
create policy content_items_insert_admin
  on public.content_items for insert to authenticated
  with check (public.is_admin());

create policy content_items_update_admin
  on public.content_items for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy content_items_delete_admin
  on public.content_items for delete to authenticated
  using (public.is_admin());

-- ────────────────────────────────────────────────────────────
-- 2. content_versions
-- ────────────────────────────────────────────────────────────
alter table public.content_versions enable row level security;

-- Public can read versions of published items
create policy content_versions_select_published
  on public.content_versions for select
  using (
    exists (
      select 1 from public.content_items ci
      where ci.id = content_id
        and ci.status = 'published'
    )
  );

-- Admins can read all versions
create policy content_versions_select_admin
  on public.content_versions for select to authenticated
  using (public.is_admin());

-- Only admins can write
create policy content_versions_insert_admin
  on public.content_versions for insert to authenticated
  with check (public.is_admin());

create policy content_versions_update_admin
  on public.content_versions for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy content_versions_delete_admin
  on public.content_versions for delete to authenticated
  using (public.is_admin());

-- ────────────────────────────────────────────────────────────
-- 3. memberships
-- ────────────────────────────────────────────────────────────
alter table public.memberships enable row level security;

-- Users can read their own membership
create policy memberships_select_own
  on public.memberships for select to authenticated
  using (user_id = auth.uid());

-- Admins can read all memberships
create policy memberships_select_admin
  on public.memberships for select to authenticated
  using (public.is_admin());

-- Only admins can insert / update / delete memberships
create policy memberships_insert_admin
  on public.memberships for insert to authenticated
  with check (public.is_admin());

create policy memberships_update_admin
  on public.memberships for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy memberships_delete_admin
  on public.memberships for delete to authenticated
  using (public.is_admin());

-- ────────────────────────────────────────────────────────────
-- 4. Harden publish_content_version() with admin check
-- ────────────────────────────────────────────────────────────
create or replace function public.publish_content_version(
  p_content_id uuid,
  p_version_id uuid,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only admins may publish content
  if not public.is_admin() then
    raise exception 'permission_denied: only admins can publish content';
  end if;

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

commit;
