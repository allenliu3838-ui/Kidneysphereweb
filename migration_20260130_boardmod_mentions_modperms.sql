-- MIGRATION_20260130_BOARDMOD_MENTIONS_MODPERMS.sql
--
-- 目的：
-- 1) 版主/管理员发帖权限：板块版主（board_moderators）也视为“可发病例/可回复病例/可上传病例附件”（满足 cases/case_comments/attachments 的 is_doctor_verified 门槛）
-- 2) 版主删帖权限：
--    - 病例（cases）/病例回复（case_comments）：板块版主可删除本板块内容
--    - 社区动态（moments）/留言（moment_comments）：全站版主（profiles.role = 'moderator'）可删除
--
-- 安全：幂等（可重复执行）。执行后建议 Supabase Settings → API → Reload schema。

begin;

-- -----------------------------------------------------------------------------
-- 0) Helper: 全站版主（moderator）判定
-- -----------------------------------------------------------------------------
create or replace function public.is_moderator()
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
      and lower(coalesce(p.role,'')) in ('owner','super_admin','admin','moderator')
  );
$$;

grant execute on function public.is_moderator() to anon, authenticated;


-- -----------------------------------------------------------------------------
-- 1) Helper: 板块版主判定（board_moderators）
--    - 兼容：若未创建 board_moderators 表，则返回 false
-- -----------------------------------------------------------------------------
create or replace function public.is_board_moderator(_board_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  ok boolean := false;
  reg regclass;
begin
  uid := auth.uid();
  if uid is null then
    return false;
  end if;

  reg := to_regclass('public.board_moderators');
  if reg is null then
    return false;
  end if;

  execute 'select exists(select 1 from public.board_moderators bm where bm.board_key = $1 and bm.user_id = $2)'
    into ok
    using lower(coalesce(_board_key,'')), uid;

  return coalesce(ok, false);
end;
$$;

grant execute on function public.is_board_moderator(text) to anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2) Expand doctor gate: 将板块版主也视为“可发病例/可回帖/可上传病例附件”
--    - 注意：cases / case_comments / attachments 的 RLS policy 使用 is_doctor_verified()
-- -----------------------------------------------------------------------------
create or replace function public.is_doctor_verified()
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  ok boolean := false;
  reg regclass;
begin
  uid := auth.uid();
  if uid is null then
    return false;
  end if;

  -- Roles that imply verified access
  select exists(
    select 1
    from public.profiles p
    where p.id = uid
      and lower(coalesce(p.role,'')) in (
        'owner','super_admin','admin','moderator',
        'doctor_verified','doctor'
      )
  ) into ok;

  if ok then return true; end if;

  -- Board moderators: treat as verified for posting/replying
  reg := to_regclass('public.board_moderators');
  if reg is not null then
    execute 'select exists(select 1 from public.board_moderators bm where bm.user_id = $1)'
      into ok
      using uid;
    if ok then return true; end if;
  end if;

  -- Fallback: approved doctor verification record (if table exists)
  reg := to_regclass('public.doctor_verifications');
  if reg is not null then
    begin
      execute 'select exists(select 1 from public.doctor_verifications dv where dv.user_id = $1 and lower(coalesce(dv.status, '''')) = ''approved'')'
        into ok
        using uid;
    exception when undefined_column then
      -- some early schemas may not have dv.status
      execute 'select exists(select 1 from public.doctor_verifications dv where dv.user_id = $1)'
        into ok
        using uid;
    end;
    if ok then return true; end if;
  end if;

  return false;
end;
$$;

grant execute on function public.is_doctor_verified() to anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3) Soft-delete RPCs: 增强删帖权限
-- -----------------------------------------------------------------------------

-- 3.1) delete_case: 作者 / 管理员 / 全站版主 / 板块版主 可删除（软删）
create or replace function public.delete_case(_case_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  owner uuid;
  bkey text;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select c.author_id, c.board into owner, bkey
  from public.cases c
  where c.id = _case_id;

  if owner is null then
    raise exception 'case not found';
  end if;

  if not (
    owner = uid
    or public.is_moderator()
    or public.is_board_moderator(bkey)
  ) then
    raise exception 'not allowed';
  end if;

  update public.cases
    set deleted_at = now()
  where id = _case_id;

  -- also soft-delete its comments
  update public.case_comments
    set deleted_at = now()
  where case_id = _case_id and deleted_at is null;
end;
$$;

grant execute on function public.delete_case(bigint) to authenticated;


-- 3.2) delete_case_comment: 评论作者 / 病例作者 / 管理员 / 全站版主 / 板块版主 可删除（软删）
create or replace function public.delete_case_comment(_comment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  c_author uuid;
  c_case_id bigint;
  case_author uuid;
  bkey text;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select cc.author_id, cc.case_id
    into c_author, c_case_id
  from public.case_comments cc
  where cc.id = _comment_id;

  if c_author is null then
    raise exception 'comment not found';
  end if;

  select c.author_id, c.board into case_author, bkey
  from public.cases c
  where c.id = c_case_id;

  if not (
    public.is_moderator()
    or public.is_board_moderator(bkey)
    or c_author = uid
    or case_author = uid
  ) then
    raise exception 'not allowed';
  end if;

  update public.case_comments
    set deleted_at = now()
  where id = _comment_id;
end;
$$;

grant execute on function public.delete_case_comment(bigint) to authenticated;


-- 3.3) delete_moment: 作者 / 管理员 / 全站版主 可删除（软删）
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

  if not (public.is_moderator() or owner = uid) then
    raise exception 'not allowed';
  end if;

  update public.moments
    set deleted_at = now()
  where id = _moment_id;
end;
$$;

grant execute on function public.delete_moment(bigint) to authenticated;


-- 3.4) delete_moment_comment: 评论作者 / 动态作者 / 管理员 / 全站版主 可删除（软删）
create or replace function public.delete_moment_comment(_comment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
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

  if not (
    public.is_moderator()
    or uid = owner
    or uid = moment_owner
  ) then
    raise exception 'not allowed';
  end if;

  update public.moment_comments
  set deleted_at = now()
  where id = _comment_id and deleted_at is null;
end;
$$;

grant execute on function public.delete_moment_comment(bigint) to authenticated;

commit;
