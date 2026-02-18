# KidneySphere Phase 1 Stable（可直接上线测试 / App-ready 架构）

这套代码的目标：

- ✅ **注册/登录稳定**（Phase 1 绝对优先）
- ✅ **登录后可发布病例**（最小但闭环：标题/摘要/标签）
- ✅ **病例讨论为社区最核心板块**：分区支持后续扩容（管理员可新增）
- ✅ **预留临床研究讨论 / 基础研究讨论 / 英语讨论**（Phase 1 先“筹备中”占位）
- ✅ **前沿进展 Sponsor Magnet**：Phase 1 静态卡片占位，Phase 2 接后台维护

技术选型：**纯静态站（HTML/CSS/JS） + Supabase（Auth + Database + RLS）**

---

## 1) 部署（Netlify 最简单）

把整个文件夹内容上传到 Netlify 站点根目录即可（包含 index.html / 其它页面 / assets 文件夹）。

- 推荐先部署一个 **test 站** 用于真实手机测试（HTTPS 环境更接近上线）。
- 部署后可打开 `/health.html` 快速自检：是否已配置 Supabase、是否已登录、session 是否存在。
- 参考更详细的步骤：`DEPLOY_NETLIFY.md` / `TEST_CHECKLIST.md`。

---

## 2) 启用真实注册/登录（必须做）

打开 `assets/config.js`，填入：

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

这两个值在 Supabase 控制台：Project Settings → API。

> 这两个是公开可用的前端 key，**真实安全由 Supabase 的 RLS（Row Level Security）控制**。

---

## 3) Supabase 建表（Phase 1 最小化 + 可扩展）

### A. cases 表（病例发布/列表）

在 Supabase SQL Editor 运行：

```sql
create table if not exists public.cases (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  board text not null,              -- 对应病例分区 key：glom/tx/icu/peds/...（可扩容）
  title text not null,
  summary text not null,
  tags text[] null,
  author_id uuid not null,
  author_name text null
);

alter table public.cases enable row level security;

-- Phase 1：登录即可读；登录即可写
create policy "cases_select_authed"
on public.cases for select
to authenticated
using (true);

create policy "cases_insert_authed"
on public.cases for insert
to authenticated
with check (auth.uid() = author_id);
```

---

### B. profiles 表（强烈建议启用：用于角色/管理员/未来医生审核）

> **重要：管理员权限只信 profiles.role，不信 user_metadata。**

```sql
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'member', -- member / doctor_pending / doctor_verified / industry / admin / super_admin
  avatar_url text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 登录用户可读（Phase 1 简化；后续可改成仅本人可读 + 管理员可读）
create policy "profiles_select_authed"
on public.profiles for select
to authenticated
using (true);

-- Phase 1：建议不要让普通用户直接写 role。
-- 如果你确实需要用户更新姓名/头像，建议用 RPC/函数方式限制字段；
-- 这里保持最小化：先不开放 insert/update 给前端。
```

#### 管理员判定函数（给 RLS 用）

```sql
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role,'')) in ('admin','super_admin')
  );
$$;
```

---

### C. 社区结构表：channels / sections（建议启用，用于“可新增分区/未来多板块/对接 App”）

> 如果你不建这两张表，网站仍能工作（会回落到默认 4 分区 + 3 个筹备板块）。

#### channels（讨论板块：病例/临床/基础/英语）

```sql
create table if not exists public.channels (
  id text primary key,              -- case / clinical / basic / english
  title_zh text not null,
  title_en text,
  description text,
  status text not null default 'active' check (status in ('active','coming_soon','hidden')),
  sort int not null default 0
);

alter table public.channels enable row level security;

-- 所有人可读（匿名/登录都可）
create policy "channels_select_all"
on public.channels for select
to anon, authenticated
using (true);

-- 只有管理员可写
create policy "channels_write_admin"
on public.channels for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
```

#### sections（病例讨论分区：glom/tx/icu/peds/…，支持扩容）

```sql
create table if not exists public.sections (
  id bigserial primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  key text not null,                -- glom / tx / icu / peds / dialysis ...
  title_zh text not null,
  title_en text,
  description text,
  status text not null default 'active' check (status in ('active','hidden')),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists sections_channel_key_uq on public.sections(channel_id, key);

alter table public.sections enable row level security;

-- 所有人可读（匿名/登录都可）
create policy "sections_select_all"
on public.sections for select
to anon, authenticated
using (true);

-- 只有管理员可写
create policy "sections_write_admin"
on public.sections for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
```

#### 预置数据（推荐：一次写入）

```sql
insert into public.channels (id, title_zh, title_en, description, status, sort)
values
  ('case','病例讨论','Case Discussion','核心板块：按分区沉淀病例与决策要点。','active',10),
  ('clinical','临床研究讨论','Clinical Research','试验设计、统计解读、真实世界研究等。','coming_soon',20),
  ('basic','基础研究讨论','Basic Research','机制研究、模型、组学与免疫等。','coming_soon',30),
  ('english','英语讨论区','English Discussion','面向国际协作与学术沟通。','coming_soon',40)
on conflict (id) do update set
  title_zh=excluded.title_zh,
  title_en=excluded.title_en,
  description=excluded.description,
  status=excluded.status,
  sort=excluded.sort;

insert into public.sections (channel_id, key, title_zh, description, status, sort)
values
  ('case','glom','肾小球病','IgAN、MN、FSGS、MCD、AAV、补体相关病等。','active',10),
  ('case','tx','肾移植内科','排斥、感染、免疫抑制、围手术期与长期随访。','active',20),
  ('case','icu','重症肾内','AKI/CRRT、休克、抗凝、液体管理、酸碱电解质。','active',30),
  ('case','peds','儿童肾病','儿肾病例、遗传肾病、补体病、儿童移植随访。','active',40)
on conflict (channel_id, key) do update set
  title_zh=excluded.title_zh,
  description=excluded.description,
  status=excluded.status,
  sort=excluded.sort;
```

---

### D. about_showcase 表（关于页展示区：管理员可增删）

```sql
create table if not exists public.about_showcase (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  category text not null check (category in ('flagship','partners','experts')),
  title text not null,
  description text,
  link text,
  sort int not null default 0
);

alter table public.about_showcase enable row level security;

-- 所有人都可读（匿名/登录都可）
create policy "about_showcase_select_all"
on public.about_showcase for select
to anon, authenticated
using (true);

-- 只有管理员可写（insert/update/delete）
create policy "about_showcase_write_admin"
on public.about_showcase for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
```

---

## 4) Phase 1 管理员（上线测试阶段：先简化，后续可扩展）

> 你当前的主要目标是“网站上线测试”。所以管理员体系建议先用 **profiles.role 三档**：
>
>- `member`
>- `admin`
>- `super_admin`
>
后续要扩展成“很多管理员 + 分工权限（RBAC）”时，再升级也不会返工。

### 方式 1（推荐）：邮箱白名单自动授予（省运营）

> 思路：把管理员邮箱写入 whitelist。管理员首次用邮箱注册时，触发器自动创建 profiles 并写入 role。

```sql
create table if not exists public.role_whitelist_email (
  email text primary key,
  role text not null check (role in ('super_admin','admin')),
  constraint email_format check (position('@' in email) > 1)
);

-- 写入管理员邮箱（示例：把 admin@example.com 替换成真实邮箱）
insert into public.role_whitelist_email (email, role) values
  ('admin@example.com','super_admin'),
  ('admin2@example.com','admin')
on conflict (email) do update set role=excluded.role;

-- 注册/首次登录时自动创建 profile + 分配角色
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select rw.role into v_role
  from public.role_whitelist_email rw
  where lower(rw.email) = lower(new.email)
  limit 1;

  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    coalesce(v_role, 'member')
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    role = excluded.role,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

> 说明：该触发器会在用户注册时自动生成 profiles 记录，并把 whitelist 中的邮箱赋予 admin/super_admin。

### 方式 2（简单）：手工改 profiles.role

你也可以先创建 4 个账号，再在 SQL Editor 里手工设置：

```sql
update public.profiles set role='super_admin' where id='<SUPER_ADMIN_UUID>';
update public.profiles set role='admin' where id='<ADMIN_UUID_1>';
update public.profiles set role='admin' where id='<ADMIN_UUID_2>';
update public.profiles set role='admin' where id='<ADMIN_UUID_3>';
```

---

## 5) 你会看到什么（这版网站的变化）

- 右上角登录态：未登录显示「登录/注册」；登录后显示头像/姓名 + 退出
- 社区讨论页：
  - 顶层显示 4 个 Channels（病例讨论已开放，其余筹备中）
  - 病例讨论分区列表支持从 `sections` 表动态加载
  - 管理员登录后可在社区页 **新增/删除分区**（写入 `sections` 表）
- 发布病例页：分区下拉框会自动同步 `sections` 表
- 关于页展示区：管理员可增删（写入 `about_showcase` 表）

---

## 6) 下一轮（Phase 2）优先级建议

1. 医生身份审核：`doctor_pending` → `doctor_verified`，并在 RLS 中限制“仅医生可发/可评”
2. 评论回复（cases_comments 表）+ 通知（notifications 表）
3. 前沿进展接入 Supabase：后台可维护、置顶、赞助标识、品牌页
4. App MVP：优先做“病例浏览 + 前沿进展浏览 + 登录 + 通知”

---

如需我继续把 **“前沿进展后台化 + 通知 + 医生审核 + App Deep Link 回调策略”** 一起打通，我们就进入第二轮。
