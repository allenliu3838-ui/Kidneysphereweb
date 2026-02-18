# 2026-01-28 代码优化与安全改进（v8_16_9）

本次改动聚焦：更安全的会话存储、更私密的附件访问、更稳健的全局对象、以及几处性能/代码质量修复。

## 1) 前端（JS/HTML）
- **不再覆盖 window.KS**：从 `window.KS = {...}` 改为 `Object.assign(window.KS, {...})`，避免后加载脚本覆盖已有字段（app.js）。
- **SafeStorage：不再把 Session 镜像到 Cookie**：仅在 Web Storage 不可用时才用 Cookie 兜底，并会清理旧的镜像 Cookie（supabaseClient.js）。
- **About 图片上传：禁用 SVG**：`png/jpg/webp/gif`，避免 SVG 潜在脚本注入/策略绕过（app.js）。
- **附件（attachments bucket）改为私有 + Signed URL**：
  - 上传时不再写入不可用的 `public_url`（改为 null）。
  - 加载时批量生成 Signed URL（有效期 1h），并在无法访问时不渲染链接（moments.js / case.html / post-case.html）。
- **上传路径更强唯一性**：使用 `crypto.randomUUID()`（无则回退到时间戳+随机数）来生成文件 key，降低碰撞概率（app.js / moments.js / case.html / post-case.html / expertPpt.js）。
- **修复 moments.js 中重复字段**：去掉 `comment_count` 重复 select。

## 2) 数据库（SQL）
- **attachments bucket：public=false**，并将 storage.objects 读权限收紧为 authenticated。
- **attachments 表读取策略拆分**：
  - `target_type='expert_ppt'` 允许公开读取（网站内容库）。
  - 其他 target_type 仅允许 authenticated（敏感内容）。
- **cases.comment_count 自动维护**：新增函数 + 触发器，插入/更新/删除（含软删除）case_comments 时自动重算。
- **性能索引**：为 cases、case_comments、moments 增加常用查询索引（where deleted_at is null）。

> 若你是增量升级：请在 Supabase SQL Editor 运行新增迁移 `MIGRATION_20260128_ATTACHMENTS_PRIVATE_SIGNED_CASE_COMMENTCOUNT.sql`，然后到 Settings → API 点击 “Reload schema”。
