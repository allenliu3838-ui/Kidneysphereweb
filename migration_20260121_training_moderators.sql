-- KidneySphere - Training Programs + Board Moderators (v8.14)
--
-- Adds:
-- 1) training_programs: editable "培训项目" list (used on 首页 + 学习中心)
-- 2) board_moderators: per-board moderators (used for "版主"徽标 + 板块版主展示)
--
-- IMPORTANT:
-- - Run in Supabase SQL Editor (as postgres).
-- - Safe to re-run (idempotent).
-- - After running: Settings → API → "Reload schema".
--
-- Optional (advanced): you can also run this in SQL editor:
--   NOTIFY pgrst, 'reload schema';

begin;

-- 0) Ensure admin helper includes super_admin
-- NOTE: older deployments might have is_admin() that only checks 'admin'.
-- Re-defining it here makes super_admin and admin both pass RLS policies below.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists(
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role,'')) in ('super_admin','admin','owner')
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- 1) training_programs
create table if not exists public.training_programs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,
  description text,
  status text not null default 'planning', -- active | planning | coming_soon | archived
  badge text,
  is_paid boolean not null default true,
  link text,
  sort int not null default 0,
  deleted_at timestamptz
);

create index if not exists training_programs_sort_idx on public.training_programs(sort);

alter table public.training_programs enable row level security;

-- keep updated_at fresh
create or replace function public.trg_touch_training_programs_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_training_programs_updated_at on public.training_programs;
create trigger trg_touch_training_programs_updated_at
before update on public.training_programs
for each row execute function public.trg_touch_training_programs_updated_at();

-- Policies
-- Read: public (but only non-deleted items); admins can also read deleted.
drop policy if exists training_programs_select_all on public.training_programs;
create policy training_programs_select_all
on public.training_programs
for select
to anon, authenticated
using (
  deleted_at is null
  or public.is_admin()
);

-- Write: admin only
-- (Use one policy covering insert/update/delete)
drop policy if exists training_programs_write_admin on public.training_programs;
create policy training_programs_write_admin
on public.training_programs
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Seed default rows if empty
do $$
begin
  if not exists (select 1 from public.training_programs where deleted_at is null) then
    insert into public.training_programs (title, description, status, badge, is_paid, link, sort)
    values
      ('儿童肾脏病培训项目', '系统课程 + 病例讨论：从常见到疑难，逐步建立儿肾临床思维。', 'planning', '筹备中', true, null, 10),
      ('重症肾内与透析培训项目', 'CRRT/抗凝/电解质酸碱/透析并发症：以真实问题为导向。', 'planning', '规划中', true, null, 20),
      -- 肾小球病培训项目：默认标记为“进行中”（如需调整可在后台编辑）
      ('肾小球病培训项目', 'IgAN/MN/FSGS/AAV/补体相关：病理-临床整合到治疗决策。', 'active', '进行中', true, null, 30),
      ('肾移植内科培训项目', '排斥/感染/免疫抑制/随访：覆盖移植内科核心路径。', 'planning', '规划中', true, null, 40);
  end if;
end $$;

-- 若历史数据仍为“规划中”，将“肾小球病培训项目”更新为“进行中”（不覆盖已自定义的情况）
update public.training_programs
set status = 'active',
    badge = '进行中'
where deleted_at is null
  and title = '肾小球病培训项目'
  and lower(coalesce(status,'')) <> 'active'
  and coalesce(badge,'') in ('', '规划中', '筹备中');


-- 2) board_moderators
create table if not exists public.board_moderators (
  id bigserial primary key,
  board_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(board_key, user_id)
);

create index if not exists board_moderators_board_idx on public.board_moderators(board_key);
create index if not exists board_moderators_user_idx on public.board_moderators(user_id);

alter table public.board_moderators enable row level security;

create or replace function public.trg_touch_board_moderators_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_board_moderators_updated_at on public.board_moderators;
create trigger trg_touch_board_moderators_updated_at
before update on public.board_moderators
for each row execute function public.trg_touch_board_moderators_updated_at();

-- Policies
-- Read: everyone (the platform UI needs to show "板块版主" + "版主"徽标)
drop policy if exists board_moderators_select_all on public.board_moderators;
create policy board_moderators_select_all
on public.board_moderators
for select
to anon, authenticated
using (true);

-- Write: admin only
 drop policy if exists board_moderators_write_admin on public.board_moderators;
create policy board_moderators_write_admin
on public.board_moderators
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

commit;
