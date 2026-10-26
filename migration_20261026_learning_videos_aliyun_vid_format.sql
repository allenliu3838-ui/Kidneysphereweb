-- APPLIED to production (project eaatpwakhcjxjonlyfii) on 2026-10-26 (UTC).
-- It was run through the SQL editor path (execute_sql), not the Supabase
-- migration runner, because the runner's confirmation prompt never reached the
-- operator. It therefore does NOT appear in supabase_migrations; this file is the
-- record. Safe to re-run: the function is CREATE OR REPLACE and the trigger is
-- dropped first.
--
-- Verified on the live table inside a transaction that was rolled back:
--   insert with a title as aliyun_vid            -> rejected ALIYUN_VID_INVALID
--   repaired row: good id -> title               -> rejected ALIYUN_VID_INVALID
--   unrepaired row: edit another column          -> ok
--   unrepaired row: resend the unchanged bad id  -> ok
--   repair with '  30466E85...0102 ' (spaces+caps) -> stored lower-case, trimmed
--
-- Rollback:
--   drop trigger if exists trg_learning_videos_aliyun_vid_format on public.learning_videos;
--   drop function if exists public.tg_learning_videos_validate_aliyun_vid();

-- learning_videos.aliyun_vid must hold an Aliyun VOD media id, never a title.
--
-- Incident (found 2026-10-26): 10 live courses had their course title saved in
-- aliyun_vid (e.g. '《急性肾损伤的诊疗进展与创新   赵宇亮教授》'), so play-auth asked
-- Aliyun for a video that does not exist and paying members could not watch.
-- Every write path (single form, batch upload, edit modal, SQL) accepted any
-- non-empty text. This guard lives in the database so it holds no matter which
-- front-end build is deployed.
--
-- Rules:
--   * NULL stays allowed (drafts and legacy URL-played rows have no id).
--   * Pasted whitespace (incl. the full-width space a Chinese IME inserts) is
--     trimmed and the id is lower-cased; an all-blank value becomes NULL.
--   * Anything else must be 32 lower-case hex characters — the shape of every
--     one of the 138 valid ids already stored.
--   * An UPDATE that leaves aliyun_vid unchanged is not checked, so an
--     unrelated edit (title, price, ...) of a not-yet-repaired row still works.
--
-- Named so it sorts before trg_learning_videos_preview_collision: BEFORE
-- triggers fire alphabetically, so the preview check sees the normalised id.

create or replace function public.tg_learning_videos_validate_aliyun_vid()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v text;
begin
  if new.aliyun_vid is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.aliyun_vid is not distinct from old.aliyun_vid then
    return new;
  end if;

  v := lower(btrim(new.aliyun_vid, E' \t\r\n' || chr(12288)));

  if v = '' then
    new.aliyun_vid := null;
    return new;
  end if;

  if v !~ '^[0-9a-f]{32}$' then
    raise exception 'ALIYUN_VID_INVALID: 阿里云媒体 ID 必须是 32 位字母和数字（在阿里云点播控制台视频标题下方"ID:"后面那一串），不能填写视频名称或课程名称。当前填写的是：%',
      left(new.aliyun_vid, 40)
      using errcode = '23514';
  end if;

  new.aliyun_vid := v;
  return new;
end;
$function$;

revoke all on function public.tg_learning_videos_validate_aliyun_vid() from public;
revoke all on function public.tg_learning_videos_validate_aliyun_vid() from anon, authenticated, service_role;

drop trigger if exists trg_learning_videos_aliyun_vid_format on public.learning_videos;
create trigger trg_learning_videos_aliyun_vid_format
  before insert or update of aliyun_vid on public.learning_videos
  for each row execute function public.tg_learning_videos_validate_aliyun_vid();
