# 上线测试检查清单（Phase 1 · Email 登录）

> 目的：你每次部署后按这份清单走一遍，就能快速确认“邮箱注册/登录闭环是否稳定”。

---

## A. 配置与环境

- [ ] 已在 `assets/config.js` 填入 `SUPABASE_URL` 与 `SUPABASE_ANON_KEY`
- [ ] 站点已部署到 Netlify（HTTPS）
- [ ] Supabase 已确认 Email Provider 可用（默认开启）
- [ ] （测试建议）Confirm Email 已关闭，避免确认邮件影响测试节奏

---

## B. 自检页（推荐先看）

打开：`/health.html`

- [ ] 显示“Supabase 已配置：是”
- [ ] 未登录时：Current user 显示为空 / session 为 null

---

## C. 邮箱注册 & 登录

1) 打开 `register.html`

- [ ] 能注册（邮箱 + 密码）
- [ ] 若 Confirm Email 关闭：注册后能直接登录并跳转
- [ ] 若 Confirm Email 开启：页面提示“去邮箱确认”，确认后回到 `/auth-callback.html` 能完成登录

2) 打开 `login.html`

- [ ] 用邮箱 + 密码能登录成功
- [ ] 登录后右上角显示登录态（昵称/邮箱）
- [ ] 回到 `/health.html`，能看到 user id 与 email

3) 退出

- [ ] 点击退出后 session 清空
- [ ] `/health.html` 显示未登录

---

## D. 受保护页面跳转

- [ ] 未登录访问 `post-case.html` 会跳转到 `login.html?next=...`
- [ ] 登录后会自动回到目标页面（next 回跳生效）

---

## E. 病例发布（如已建 cases 表）

- [ ] 登录后可以提交病例
- [ ] 发布成功后能在对应板块列表看到

---

## F. 失败时记录信息（方便快速定位）

如果出问题，建议你记录：
- 你访问的 Netlify 地址
- `/health.html` 的截图
- 控制台报错（浏览器开发者工具 Console）
- Supabase Auth → Logs 中对应时间段的记录（如果有）
