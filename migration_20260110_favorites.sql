-- Favorites / Bookmarks
-- Adds ability to “收藏” Moments and Cases.
--
-- Run this file in Supabase SQL Editor.
-- After running, it’s recommended to do: Settings → API → "Reload schema".

-- --------------------------
-- moment_favorites
-- --------------------------
create table if not exists public.moment_favorites (
  moment_id bigint not null references public.moments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (moment_id, user_id)
);

create index if not exists moment_favorites_user_id_idx on public.moment_favorites(user_id);
create index if not exists moment_favorites_moment_id_idx on public.moment_favorites(moment_id);

alter table public.moment_favorites enable row level security;

-- SELECT
DROP POLICY IF EXISTS "moment_favorites_select_own" ON public.moment_favorites;
CREATE POLICY "moment_favorites_select_own"
ON public.moment_favorites
FOR SELECT
USING (
  auth.uid() = user_id OR public.is_admin()
);

-- INSERT
DROP POLICY IF EXISTS "moment_favorites_insert_own" ON public.moment_favorites;
CREATE POLICY "moment_favorites_insert_own"
ON public.moment_favorites
FOR INSERT
WITH CHECK (
  auth.uid() = user_id OR public.is_admin()
);

-- DELETE
DROP POLICY IF EXISTS "moment_favorites_delete_own" ON public.moment_favorites;
CREATE POLICY "moment_favorites_delete_own"
ON public.moment_favorites
FOR DELETE
USING (
  auth.uid() = user_id OR public.is_admin()
);

-- --------------------------
-- case_favorites
-- --------------------------
create table if not exists public.case_favorites (
  case_id bigint not null references public.cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (case_id, user_id)
);

create index if not exists case_favorites_user_id_idx on public.case_favorites(user_id);
create index if not exists case_favorites_case_id_idx on public.case_favorites(case_id);

alter table public.case_favorites enable row level security;

-- SELECT
DROP POLICY IF EXISTS "case_favorites_select_own" ON public.case_favorites;
CREATE POLICY "case_favorites_select_own"
ON public.case_favorites
FOR SELECT
USING (
  auth.uid() = user_id OR public.is_admin()
);

-- INSERT
DROP POLICY IF EXISTS "case_favorites_insert_own" ON public.case_favorites;
CREATE POLICY "case_favorites_insert_own"
ON public.case_favorites
FOR INSERT
WITH CHECK (
  auth.uid() = user_id OR public.is_admin()
);

-- DELETE
DROP POLICY IF EXISTS "case_favorites_delete_own" ON public.case_favorites;
CREATE POLICY "case_favorites_delete_own"
ON public.case_favorites
FOR DELETE
USING (
  auth.uid() = user_id OR public.is_admin()
);
