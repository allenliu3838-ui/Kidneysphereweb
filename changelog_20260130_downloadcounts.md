# 2026-01-30 下载次数统计（v8_16_11）

本次改动：为 **文章** 与 **专家 PPT** 增加「下载次数」统计，并在前端页面展示。

## 1) 数据库（SQL）
- 新增迁移：`MIGRATION_20260130_DOWNLOADCOUNT_ARTICLE_PPT.sql`
  - `public.articles`：新增 `download_count`（默认 0）+ RPC `increment_article_download(uuid)`
  - `public.expert_ppts`：新增 `download_count`（默认 0）+ RPC `increment_expert_ppt_download(bigint)`
  - 两个 RPC 均对 `anon, authenticated` 授权执行（安全 definer + 仅对有效内容自增）

> 运行后请在 Supabase：Settings → API → Reload schema。

## 2) 前端（展示 + 自增）
- 文章：
  - 列表页/学习中心/首页预览：显示「下载」计数（若字段已迁移）。
  - 文章详情页：显示「下载」计数；点击正文中的 PDF/file-chip（如 `{{pdf:...}}`）会触发自增。
- 专家 PPT：
  - 列表页：显示「下载」计数；点击「下载PPT/PDF/文件」会触发自增。
  - 在线阅读页：标题信息中显示「下载」计数；点击右上角「下载」或附件区下载链接会触发自增。

## 3) 兼容性
- 若你的数据库暂未运行本迁移，前端会自动降级：
  - 不显示下载数；
  - 自增 RPC 不存在时会静默忽略。
