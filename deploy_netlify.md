# Netlify 上线测试部署指南（Email 登录优先版）

这份指南的目标：让你在 **不需要网站最终定稿** 的情况下，先把站点部署到 Netlify，并把 **邮箱注册/登录**跑通。

> 说明：这是纯静态站（HTML/CSS/JS），Netlify 部署属于“上传即发布”。后面你大面积改动也不麻烦：重新部署就行，Netlify 会保留历史版本，必要时可以回滚。

---

## 1) 推荐部署策略（避免边改边影响测试）

- **一个测试站（test）**：给自己/测试用户稳定使用。
- **一个开发站（dev）**：你随便改，改好了再同步到 test。

如果你现在只想先跑通登录，也可以先只建一个站点，后面再拆分。

---

## 2) 部署前要做的唯一配置：assets/config.js

打开 `assets/config.js`，填入 Supabase：
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

这两个值在 Supabase 控制台：**Project Settings → API**。

> 提醒：为了减少浏览器缓存干扰，本项目已在 `netlify.toml` 里对 `assets/config.js` 设置了 no-store（你改了配置后刷新就能生效）。

---

## 3) Netlify 部署（手动拖拽，最省事）

1. 登录 Netlify
2. **Add new site → Deploy manually**
3. 把“项目文件夹里所有文件”拖进去（包含 `index.html` 那一层，而不是外层 zip）
4. 部署完成后，得到一个站点地址（`xxxx.netlify.app`）

---

## 4) Supabase 必备配置（Email 登录）

在 Supabase Console：

### A) Email Provider
- Email 登录默认是开启的，但你仍然建议检查一下：
  - **Authentication → Sign In / Providers → Email**

### B) Confirm Email（测试阶段建议关闭）
- 为了避免“收不到确认邮件/进垃圾箱”影响测试进度，建议测试阶段先关闭：
  - **Authentication → Sign In / Providers**（或 General Configuration）里把 **Confirm Email** 关掉

> 关闭后：用户注册会直接获得 session，不需要点邮件确认链接。

### C) URL Configuration（建议设置）
- **Authentication → URL Configuration**
  - Site URL：填你的 Netlify 域名，例如 `https://xxxx.netlify.app`
  - Redirect URLs：至少加上：
    - `https://xxxx.netlify.app/auth-callback.html`

如果你未来要开启 Confirm Email 或做“忘记密码”，这一步非常关键。

---

## 5) 最短测试路径

1. 用浏览器打开：`/health.html`（站点自检页）
2. 打开：`/register.html` 注册一个邮箱账号
3. 打开：`/login.html` 用邮箱 + 密码登录
4. 登录成功后再回到：`/health.html`
   - 能看到 session / user.email

---

## 6) 下一步（上线测试优先）

登录打通后，我们按顺序推进：
1) 导航改“一行 + Logo 放大”（PC/手机头部一行）
2) 学习中心：历史视频免费（登录可看）+ 培训项目锁定（付费提示）
3) 病例讨论 MVP：登录后可发、可看
