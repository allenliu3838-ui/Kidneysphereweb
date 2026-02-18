-- 2026-01-06
-- Add public speaker fields to event_series so ALL visitors can see speaker info.

alter table public.event_series add column if not exists speaker_name text;
alter table public.event_series add column if not exists speaker_title text;
alter table public.event_series add column if not exists speaker_bio text;
