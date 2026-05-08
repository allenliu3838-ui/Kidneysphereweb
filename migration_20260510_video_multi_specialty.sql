-- ============================================================
-- Migration: 20260510 Many-to-Many Video Specialty Assignments
-- ------------------------------------------------------------
-- Goal: a single video can belong to multiple training projects /
-- specialties (e.g. 《尿显微镜》in both 肾小球 and 肾移植).
--
-- 1. Add learning_videos.specialty_ids (uuid[])
-- 2. Backfill: copy existing specialty_id into specialty_ids[1]
-- 3. Replace normalize trigger:
--    - source='glomcon' → specialty_ids='{}' (and specialty_id=null)
--    - is_paid=false   → membership_accessible=false
--    - Bidirectional sync: specialty_ids[1] ↔ specialty_id, so legacy
--      callers reading specialty_id still see something sensible.
-- 4. GIN index on specialty_ids for fast contains-queries
-- 5. Re-run backfill (idempotent) so the constraint that source='glomcon'
--    implies empty specialty_ids holds for existing rows.
--
-- Safe to re-run.
-- ============================================================

-- ============================================================
-- 1. ADD specialty_ids column
-- ============================================================
alter table public.learning_videos
  add column if not exists specialty_ids uuid[] not null default '{}'::uuid[];

-- ============================================================
-- 2. ONE-TIME BACKFILL: specialty_id → specialty_ids[1]
-- ============================================================
update public.learning_videos
set specialty_ids = array[specialty_id]
where specialty_id is not null
  and (specialty_ids is null or specialty_ids = '{}'::uuid[]);

-- ============================================================
-- 3. REPLACE normalize trigger to keep specialty_id ↔ specialty_ids[1] in sync
--    and enforce GlomCon ⊥ specialty_ids exclusivity
-- ============================================================
create or replace function public.tg_learning_videos_normalize_access()
returns trigger
language plpgsql
as $$
begin
  -- GlomCon source: lock to membership-only, clear all specialty assignments
  if new.source = 'glomcon' then
    new.is_paid := true;
    new.membership_accessible := true;
    new.specialty_id := null;
    new.specialty_ids := '{}'::uuid[];
  end if;

  -- Free videos shouldn't carry membership flag
  if coalesce(new.is_paid, false) = false then
    new.membership_accessible := false;
  end if;

  -- Bidirectional sync between legacy specialty_id and new specialty_ids[]
  -- Priority: if specialty_ids changed (and is non-empty), specialty_id := first element
  -- Else if specialty_id changed (or is set without array), seed specialty_ids
  if new.source != 'glomcon' or new.source is null then
    if (tg_op = 'INSERT')
       or coalesce(old.specialty_ids, '{}'::uuid[]) is distinct from coalesce(new.specialty_ids, '{}'::uuid[]) then
      -- specialty_ids changed: project to specialty_id (first non-null element, or null)
      if array_length(new.specialty_ids, 1) is not null and new.specialty_ids[1] is not null then
        new.specialty_id := new.specialty_ids[1];
      else
        new.specialty_id := null;
      end if;
    elsif coalesce(old.specialty_id, '00000000-0000-0000-0000-000000000000'::uuid)
           is distinct from coalesce(new.specialty_id, '00000000-0000-0000-0000-000000000000'::uuid) then
      -- Only specialty_id changed: seed/replace first slot of specialty_ids
      if new.specialty_id is not null then
        if coalesce(array_length(new.specialty_ids, 1), 0) = 0 then
          new.specialty_ids := array[new.specialty_id];
        else
          new.specialty_ids[1] := new.specialty_id;
        end if;
      else
        new.specialty_ids := '{}'::uuid[];
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_learning_videos_normalize_access on public.learning_videos;
create trigger trg_learning_videos_normalize_access
before insert or update on public.learning_videos
for each row
execute function public.tg_learning_videos_normalize_access();

-- ============================================================
-- 4. GIN INDEX for fast `where <id> = any(specialty_ids)` queries
-- ============================================================
create index if not exists idx_learning_videos_specialty_ids
  on public.learning_videos
  using gin (specialty_ids);

-- ============================================================
-- 5. RE-RUN BACKFILL after trigger is in place
--    (ensures source='glomcon' rows have specialty_ids='{}')
-- ============================================================
update public.learning_videos
set specialty_ids = '{}'::uuid[]
where source = 'glomcon'
  and array_length(specialty_ids, 1) is not null;

-- ============================================================
-- DONE
-- ============================================================
