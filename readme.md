# KidneySphere Phase 1 · Full Build (v11 · v4)

本版本为“可一次部署”的整合包（静态站点 + Supabase 后端），包含：

- ✅ 邮箱注册/登录（含忘记密码/重置密码）
- ✅ 五大核心社区：肾小球与间质性肾病 / 肾移植内科 / 重症肾内（电解质/酸碱）与透析 / 儿童肾脏病 / 罕见肾脏病
- ✅ 发布病例（最简版：标题 + 摘要 + 标签）
- ✅ 病例详情页 + 评论回复（最简版）
- ✅ 发帖人可“软删除”自己的病例/评论/动态（管理员可删所有）
  - 为了避免 RLS 边界导致的 403，本版本在数据库中增加了 RPC：`delete_case` / `delete_case_comment` / `delete_moment`（SUPABASE_SETUP.sql 内已包含）
  - 新增 Moments 留言 RPC：`add_moment_comment` / `delete_moment_comment`（用于留言/回复的创建与删除）
- ✅ 学习中心：4 个培训项目占位（付费接口预留）+ 免费视频库（登录后观看播放页）
- ✅ 会议与活动：支持“状态/最后更新时间/下次时间”，可从数据库读取（不固定也能更新）
- ✅ 会议与活动（管理员）：可在 `events.html` 直接改会议时间 / 改状态（确认/改期/取消）/ 更新入会链接
- ✅ 讲者头像：会议可上传讲者头像，在首页/活动页显示
- ✅ 文章专栏：类似公众号的长文沉淀（列表/详情/编辑器；首页展示最新文章）
- ✅ 权限管理：超级管理员可在 admin.html 分配管理员角色（admin/super_admin）
- ✅ Moments 视频链接：支持粘贴 B站/腾讯会议回放等外链（自动预览），可与图片混发
- ✅ 统一管理后台：`admin.html` 同时管理「会议与活动」+「临床研究中心」（中心信息 + 项目库）
- ✅ 社区动态 Moments：支持文字 + 图片/短视频（复制粘贴 / 拖拽 / 选择文件），支持发布后“编辑并保存修改”（可选重新置顶）
- ✅ 社区动态留言/回复：其他会员可留言，作者可回复（支持二级回复；可删除自己的留言，作者/管理员可删除）
- ✅ 点赞：Moments + 病例详情页支持点赞/取消点赞（用于“质量”信号）
- ✅ 收藏：Moments（社区动态）+ 病例讨论支持收藏/取消收藏（个人书签）
- ✅ 积分与等级：基于发帖数量 + 点赞质量的积分，自动映射为 12 级（青铜/白银/黄金/铂金 × I/II/III）
- ✅ 临床研究中心（GlomCon中国临床研究中心）：项目库框架（可管理员维护）
- ✅ 关于页：旗舰中心 / 合作伙伴 / 核心专家团队（管理员可维护，支持图片/Logo/照片 URL）
- ✅ 专家介绍页：新增独立页面 experts.html，用于对外展示“核心专家”
- ✅ Word 风格富文本：文章编辑 / 病例讨论 / 评论支持加粗、颜色、列表、表格、粘贴 Word 自动清理与适配移动端
- ✅ 站内搜索：文章 / 病例 / 动态 / 会议 / 研究项目 / 专家（基于 pg_trgm，适配中文检索）

> 重要说明：前端一次部署即可；但需要在 Supabase 做一次性初始化（运行 SQL 脚本 + 配置 Auth Redirect）。

---

## 0) 你需要准备什么

- 一个 Supabase 项目（Free 版即可，Phase 1 不需要 Pro）
- 一个 Netlify 站点（或任意静态站点托管）
- 一个可用的域名（可选）

---

## 1) Supabase 一次性初始化（必须）

### 1.1 填写前端配置

编辑 `assets/config.js`：

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### 1.2 运行 SQL 初始化脚本

在 Supabase 控制台：

`SQL Editor → New query → 粘贴并运行`：

- 文件：`SUPABASE_SETUP.sql`

然后（如果你使用的是 v6_5 及之后的增量包），再运行：

- 文件：`MIGRATION_20260107_NEXT.sql`（新增 articles 表 / speaker 头像 / super-admin 权限分配）
- 文件：`MIGRATION_20260107_SPONSOR_LOGOS.sql`（新增 sponsor_logos bucket：赞助商 Logo 上传/展示）
- 文件：`MIGRATION_20260109_ARTICLE_VIEWCOUNT.sql`（新增文章浏览次数 view_count + 自增 RPC）
- 文件：`MIGRATION_20260130_DOWNLOADCOUNT_ARTICLE_PPT.sql`（新增文章/专家PPT下载次数 download_count + 自增 RPC）
- 文件：`MIGRATION_20260110_FAVORITES.sql`（新增 Moments / Cases 收藏表 + RLS）
 - 文件：`MIGRATION_20260130_BOARDMOD_MENTIONS_MODPERMS.sql`（板块版主发帖/删帖权限 + @仅显示姓名）
 - 文件：`MIGRATION_20260211_RICH_TEXT_EDITOR.sql`（新增富文本 HTML 字段：articles/cases/comments）
 - 文件：`MIGRATION_20260211_SITE_SEARCH.sql`（新增站内搜索：search_text + 索引 + RPC: search_site）

它会创建 / 更新：

- profiles（含角色、超级管理员判断）
- channels / sections（社区分区）
- cases（病例）+ case_comments（评论）+ case_likes（点赞）
- moments（社区动态）+ moment_likes（点赞）
- frontier_modules / frontier_cards / sponsors（前沿进展：模块化内容 + 赞助商）
- about_showcase（旗舰中心/伙伴/专家，含图片 URL）
- event_series / event_links（会议活动 + 会员可见链接）
- research_projects（临床研究项目库）

同时会创建 public Storage bucket：`moments`（用于动态图片/视频上传）、`speakers`（讲者头像）、`sponsor_logos`（赞助商 Logo）。

### 1.3 把你自己设为超级管理员（一次）

1) Supabase → Authentication → Users → 找到你的账号 → 复制 `User UID`  
2) SQL Editor 运行：

```sql
update public.profiles
set role = 'super_admin'
where id = '你的-User-UID';
```

---

## 2) Supabase Auth 设置（必须）

### 2.1 Redirect URLs（回调地址）

在 Supabase：

`Authentication → URL Configuration`

把下列地址加入 Allow list（根据你的域名替换）：

- Netlify 默认域名（例如）：`https://xxx.netlify.app/auth-callback.html`
- 你的正式域名（例如）：`https://kidneysphere.com/auth-callback.html`

同时建议把站点根域名也加入（登录后跳转更稳）：

- `https://xxx.netlify.app`
- `https://kidneysphere.com`

### 2.2 Password reset redirect

同一页面里，把 Password reset redirect 设为：

- `https://xxx.netlify.app/reset.html`
- （正式域名后期再改成）`https://kidneysphere.com/reset.html`

---

## 3) 部署到 Netlify（一次）

把本目录整体上传/连接到 Netlify，Build 命令留空（纯静态）。

---

## 4) 管理入口（上线后你怎么改内容）

- **关于页（About）**：旗舰中心 / 合作伙伴 / 核心专家团队（支持图片/Logo/照片 URL）
  - 仅超级管理员/管理员能看到编辑按钮
- **会议与活动（Events）**：如果需要频繁变动，推荐直接在 Supabase Table Editor 维护：
  - `event_series`：状态、下次时间、描述
  - `event_links`：已确认会议的入会链接（仅会员可见，且只有 confirmed 才会下发）

---
