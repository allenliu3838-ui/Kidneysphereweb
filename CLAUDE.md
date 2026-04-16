# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KidneySphere (肾域) is a static-site web app for a Chinese nephrology clinical research / learning community. There is **no build step** — plain HTML/CSS/JS ES modules are served directly. Supabase provides auth, Postgres (with RLS), Storage, and RPC. Netlify hosts the site and runs Functions/Edge Functions; an Express wrapper in `server/` runs the same Netlify Functions on an Alibaba Cloud ECS (behind Nginx) for the China-mainland deployment.

Primary language in the UI, DB content, and migration docstrings is Simplified Chinese. Keep user-facing strings in Chinese to match.

## Common Commands

This repo has no top-level `package.json`. There are only two scoped packages:

```bash
# Local Netlify dev (static + functions + edge functions)
netlify dev                       # usually on http://localhost:8888

# Express API server (mirrors Netlify Functions for the ECS deployment)
cd server && npm install && npm start          # http://127.0.0.1:3001

# Playwright smoke tests (install playwright separately — not in repo package.json)
npx playwright test tests/smoke.spec.js
npx playwright test tests/smoke.spec.js -g "Admin route"    # single test
BASE_URL=https://kidneysphere.com npx playwright test       # run against prod

# Deploy to Alibaba Cloud ECS (rsync + nginx reload)
./deploy/deploy.sh user@server-ip
```

Netlify deploy is "upload and publish" — no build. Both `netlify.toml` and `_redirects` define the routing. For the ECS deploy, Nginx config is in `deploy/nginx-kidneysphere.conf` and the Express API is started via PM2 (`pm2 start server/index.js --name ks-api`).

## Architecture

### Dual-deployment model

The same codebase runs two ways:

1. **Netlify** (international): static files + `netlify/functions/*` + `netlify/edge-functions/article-ssr.js`. Routing via `netlify.toml` (`/api/*` redirects, edge function binding to `/article`) and `_redirects` (pretty URLs → `.html`).
2. **Alibaba Cloud ECS** (mainland China, `kidneysphere.com`): Nginx serves static files, proxies `/api/*` to an Express server (`server/index.js`) that wraps the Netlify Function handlers via a `netlifyAdapter()` (synthesizes the `event` object). The Edge Function is **not** mirrored here — `/article` is served as a plain static page on ECS.

When adding a new backend route, add it under `netlify/functions/`, wire it in `netlify.toml` under `[[redirects]]`, and also add an `app.get/post` in `server/index.js` through `netlifyAdapter(handler)`.

### Page model — one HTML + one JS per route

Each feature is a pair like `moments.html` + `moments.js` (or `case.html` + `case.js`, `admin-commerce.html` + `admin-commerce.js`, etc.). `_redirects` rewrites pretty URLs (`/community` → `/community.html`) on Netlify; Nginx `try_files $uri $uri.html` does the same on ECS. Shared top-of-page JS (`app.js`) handles nav, auth guards, recovery-link redirects, and cache-busting. Never assume a bundler — every JS file is loaded directly by the browser as an ES module and must use full relative paths with explicit `?v=...` query strings for cache busting (see `BUILD_VERSION` in `app.js`).

### Config loading

`assets/config.js` is the single source of runtime config (Supabase URL/anon key, feature flags). It is served with `Cache-Control: no-store` (see `netlify.toml`). It exports ES module constants **and** writes them to `window.*` for legacy scripts. `supabaseClient.js` imports from `assets/config.js` and tries multiple CDNs (unpkg → jsdelivr → esm.sh → skypack → local `assets/lib/supabase.min.js`) before giving up — preserve this fallback chain when touching client init.

### Data layer — Supabase-first

All reads/writes go directly from the browser to Supabase REST/RPC using the anon key; RLS is the security boundary. RPCs are used heavily to bypass RLS pitfalls for owner-deletes and counters (e.g. `delete_case`, `delete_moment`, `add_moment_comment`, `increment_article_download`, `search_site`). When adding a new table, always include a migration that enables RLS and exposes any owner-action RPCs — do not rely on direct DELETE from the client.

Migrations live as `migration_YYYYMMDD_*.sql` at repo root. They are **run manually** in the Supabase SQL Editor in filename order, starting from `supabase_setup.sql`. After running a migration, reload the Supabase schema cache (`Dashboard → API → Reload schema`). There is no automated migration runner — new migrations must be documented in `readme.md` and, when relevant, in a matching `changelog_YYYYMMDD_*.md`.

### Netlify Edge Function — article SSR

`netlify/edge-functions/article-ssr.js` is bound to `/article` and `/article.html`. It fetches article data from Supabase, injects title/author/date/preview into the HTML response server-side (so search engines and `<noscript>` users see content). When changing `article.html`'s placeholder markers, update the edge function's string replacements accordingly. **This SSR is Netlify-only**; the ECS deployment serves the raw HTML.

### Payments — "unified commerce" module

`admin-commerce.html` + `admin-commerce.js` + `admin-commerce-*.js` (products, orders, projects, cohorts, entitlements, groups, templates, audit, config) implement a manual-review payment flow: user uploads a payment screenshot on `checkout.html` → admin approves in `admin-commerce.html` → `user_entitlements` row is written → `my-learning.html` and `watch.html` gate content on the entitlement. The DB side is introduced in `migration_20260322_unified_commerce.sql` and extended by the subsequent `migration_2026*` files. Pricing config (QR images, bank info, notice text) lives in the `system_config` table, not in `assets/config.js`.

### Video access flow

Videos on `watch.html` use a two-step auth: `GET /api/videos/:id/access` returns whether the user has an entitlement; `POST /api/videos/:id/play-auth` returns an Aliyun VOD signed play URL. Both handlers live in `netlify/functions/` and require `SUPABASE_SERVICE_ROLE_KEY` + `ALIYUN_VOD_*` env vars (see `server/.env.example`). Never call Aliyun VOD from the browser.

### Roles

Roles live in `profiles.role`: `member` | `moderator` | `admin` | `super_admin` (+ `owner` used in `qbank-schema.sql`). Admin-only UI is gated in two layers: (1) frontend hides elements (`data-admin-only`, `hidden`), and (2) RLS / RPC `security definer` checks on the DB. The smoke tests (`tests/smoke.spec.js`) assert that anonymous HTML never contains admin keywords — keep that list (`FORBIDDEN_KEYWORDS`, `BUILD_FORBIDDEN`) in sync when adding new admin features.

Admin/super-admin can toggle a view-mode (`ks_view_mode` localStorage key, see `app.js`) to browse as a normal member; this is **UI-only** and does not bypass RLS.

### QBank (question bank)

`qbank*.{html,js}` + `qbank-schema.sql` are newer and somewhat self-contained: `qbank-admin.html` for authors, `qbank-test.html` for taking questions, `qbank.html` as the bank-selector landing. Questions carry auto-generated `qid` codes and belong to a bank; uniqueness of `question_number` is scoped per-bank. Schema is in `qbank-schema.sql` plus `migration_20260410_qbank_*.sql`.

## Conventions

- **Cache-busting**: bump `BUILD_VERSION` in `app.js` and the `?v=` query on `<link rel="stylesheet">` in HTML headers when shipping (`netlify.toml` sets `max-age=0, must-revalidate` on HTML/CSS/JS, but users may still have cached copies).
- **Changelogs**: non-trivial changes get a `changelog_YYYYMMDD_<topic>.md` at repo root. DB-touching changes also add a migration file with the same date prefix.
- **Security headers / CSP**: `netlify.toml` defines a strict CSP. When adding a new external script/API host, update the `script-src` / `connect-src` directives there.
- **SEO/noindex**: admin, auth, profile, checkout, and content-creation pages must carry a `<meta name="robots" content="noindex">`. `tests/smoke.spec.js` enforces this — see the `NOINDEX_PAGES` list.
- **Pretty URLs**: when adding a new page, register it in `_redirects` (Netlify) and rely on `try_files $uri $uri.html` (Nginx, already in place). Also add it to `sitemap.xml` if public, or to `robots.txt` `Disallow` if private.
- **RPC over direct DML**: prefer a `security definer` RPC for anything RLS would otherwise block (deletes by owner, counter increments, cross-table cascades).
- **Chinese UI strings**: keep them as-is — smoke tests assert on literal Chinese keywords.
