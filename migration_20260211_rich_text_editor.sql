-- MIGRATION_20260211_RICH_TEXT_EDITOR.sql
-- Add optional rich-text HTML columns for Word-like editing.
--
-- Safe rollout:
-- - Existing plain-text / markdown flows continue to work.
-- - Frontend will prefer *_html columns when present.

alter table if exists public.articles
  add column if not exists content_html text;

alter table if exists public.cases
  add column if not exists summary_html text;

alter table if exists public.case_comments
  add column if not exists body_html text;

comment on column public.articles.content_html is 'Sanitized rich HTML for article content (preferred over content_md).';
comment on column public.cases.summary_html is 'Sanitized rich HTML for case discussion summary/body.';
comment on column public.case_comments.body_html is 'Sanitized rich HTML for case comment body.';
