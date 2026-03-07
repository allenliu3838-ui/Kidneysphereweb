# Content Sync Spec (Web + App)

## 1) 数据结构

### `content_items`
- `id` (uuid)
- `legacy_article_id` (uuid, 兼容旧 `articles.id`)
- `type` (`article` | `topic`)
- `title_zh`, `title_en`
- `summary_zh`
- `tags` (text[])
- `status` (`draft` | `in_review` | `published` | `archived`)
- `paywall` (`free_preview` | `members_only`)
- `last_published_version_id` (uuid)
- `published_at`, `updated_at`, `created_at`
- `search_text`（发布后用于搜索）

### `content_versions`
- `id` (uuid)
- `content_id` (fk)
- `version`（不可变版本号）
- `status`（与发布流程一致）
- `source_format` (`html` | `markdown` | `blocks`)
- `preview_body`（公开预览）
- `full_body`（会员全文）
- `toc_json`, `references_json`
- `created_by`, `reviewed_by`, `approved_by`
- `created_at`

### `memberships`
- `user_id`
- `status` (`active` | `expired` | `canceled` | `past_due`)
- `current_period_end`
- `plan_id`, `provider`
- `created_at`, `updated_at`

## 2) API 契约

### GET `/api/content`
Query:
- `type`, `q`, `tag`, `cursor`, `limit`, `updated_since`

Response:
```json
{
  "items": [
    {
      "id": "uuid",
      "legacy_article_id": "uuid",
      "type": "article",
      "title_zh": "IgA肾病治疗进展",
      "summary_zh": "...",
      "tags": ["IgAN", "指南"],
      "status": "published",
      "paywall": "free_preview",
      "version": "v20260305-102233",
      "preview_body": "...",
      "updated_at": "2026-03-05T10:22:33.000Z"
    }
  ],
  "next_cursor": "2026-03-05T10:22:33.000Z",
  "limit": 20
}
```

### GET `/api/content/:id?mode=preview|full`
- `preview`：所有人可读，返回 `preview_body`
- `full`：仅会员可读；非会员返回 `402/403` + `paywall`

示例（非会员）：
```json
{
  "error": "membership_required",
  "paywall": {
    "required_plan": "member",
    "action": "upgrade_membership",
    "preview_body": "..."
  }
}
```

### GET `/api/me`
```json
{
  "user": { "id": "uuid", "email": "demo@x.com" },
  "membership": { "status": "active", "plan_id": "annual" },
  "permissions": ["member", "editor"],
  "role": "editor"
}
```

## 3) 权限规则
- `preview_body`：匿名可读。
- `members_only` 的 `full_body`：必须登录且会员有效。
- `/api/content/:id?mode=full` 统一做鉴权，避免 Web/App 绕过。

## 4) 发布流程
1. `draft`：编辑器保存草稿，写入 `content_versions`（不改 `last_published_version_id`）。
2. `in_review`：可选审核态。
3. `published`：
   - 生成不可变 `version`
   - 自动生成 `preview_body`
   - 更新 `content_items.last_published_version_id` 与 `published_at`
   - 刷新 `search_text`

## 5) Web 与 App 同步策略
- 客户端列表增量拉取：`GET /api/content?updated_since=...`
- 客户端详情可缓存 `(id, version)`；版本变化再拉取。
- 旧页面 `article.html?id=...` 兼容 `legacy_article_id`，逐步迁移不打断现网。
