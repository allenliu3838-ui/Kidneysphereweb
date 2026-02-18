-- Article Favorites / Bookmarks
-- Adds ability to “收藏” Articles.
--
-- Run this file in Supabase SQL Editor.
-- After running, it’s recommended to do: Settings → API → "Reload schema".

-- --------------------------
-- article_favorites
-- --------------------------
create table if not exists public.article_favorites (
  article_id uuid not null references public.articles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (article_id, user_id)
);

create index if not exists article_favorites_user_id_idx on public.article_favorites(user_id);
create index if not exists article_favorites_article_id_idx on public.article_favorites(article_id);

alter table public.article_favorites enable row level security;

-- SELECT
DROP POLICY IF EXISTS "article_favorites_select_own" ON public.article_favorites;
CREATE POLICY "article_favorites_select_own"
ON public.article_favorites
FOR SELECT
USING (
  auth.uid() = user_id OR public.is_admin()
);

-- INSERT
DROP POLICY IF EXISTS "article_favorites_insert_own" ON public.article_favorites;
CREATE POLICY "article_favorites_insert_own"
ON public.article_favorites
FOR INSERT
WITH CHECK (
  auth.uid() = user_id OR public.is_admin()
);

-- DELETE
DROP POLICY IF EXISTS "article_favorites_delete_own" ON public.article_favorites;
CREATE POLICY "article_favorites_delete_own"
ON public.article_favorites
FOR DELETE
USING (
  auth.uid() = user_id OR public.is_admin()
);

-- Done.
