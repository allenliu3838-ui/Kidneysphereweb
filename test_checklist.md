# 上线测试检查清单（Phase 1 · Email 登录）

> 目的：你每次部署后按这份清单走一遍，就能快速确认“邮箱注册/登录闭环是否稳定”。

---

## A. 配置与环境

- [ ] 已在 `assets/config.js` 填入 `SUPABASE_URL` 与 `SUPABASE_ANON_KEY`
- [ ] 站点已部署到 Netlify（HTTPS）
- [ ] Supabase 已确认 Email Provider 可用（默认开启）
- [ ] （测试建议）Confirm Email 已关闭，避免确认邮件影响测试节奏
- [ ] 已运行最新版 `SUPABASE_SETUP.sql`（包含 Moments / Frontier / 点赞 / 积分等级 / Storage bucket）
- [ ] Storage 已存在 public bucket：`moments`（用于动态图片/短视频上传）

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
- [ ] 登录态里显示：头像（首字母） + 身份（member/医生/官方等） + Lv 等级徽标
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
- [ ] 删除病例：进入病例详情页，作者点击“删除”，跳回社区且列表不再显示该病例（网络不再 403）
- [ ] 删除评论：作者或管理员删除一条评论，评论列表中该评论消失（网络不再 403）

---

## G. Moments（社区动态）

- [ ] 能打开 `moments.html` 并看到动态流
- [ ] 纯文本发布：能成功发布一条动态
- [ ] 拖拽上传：拖拽 1-3 张图片到发布框，预览正常，发布成功后能显示图片
- [ ] 短视频发布：选择 1 个 mp4/mov，预览正常，发布成功后能播放
- [ ] 复制粘贴上传：从剪贴板粘贴图片，能进入预览并发布成功
- [ ] 点赞：对一条动态点赞/取消点赞，数量变化正常
- [ ] 删除动态：作者点击“删除”，动态从列表消失（网络不再 403）
- [ ] 编辑动态：作者点击“编辑”，修改文字或替换图片/视频后点击“保存修改”，列表刷新可见（可选：勾选“更新后置顶”测试是否置顶）

---

## H. 会议与活动管理（管理员）

- [ ] 管理员账号登录后，`events.html` 底部出现“管理员：管理会议与活动”面板
- [ ] 能修改 next_time（会议时间）并保存，前台列表立即更新
- [ ] 能把 status 改为 canceled / rescheduled，前台状态标签更新
- [ ] 能编辑 join_url / passcode（确认后普通会员可见）

---

## I. 前沿进展管理（管理员）

- [ ] 管理员账号登录后，`frontier.html` 底部出现“管理员：模块化内容管理”面板
- [ ] 能新增模块（cards / richtext / sponsors）并在页面渲染
- [ ] cards 模块：能新增卡片并展示链接/图片
- [ ] richtext 模块：能编辑正文并保存
- [ ] sponsors：能新增赞助商卡片并展示 logo / 官网链接

---

## J. 积分与等级（12 级）

- [ ] 发病例 / 发评论 / 发 Moments 后，右上角 Lv 等级或 points（title）有变化
- [ ] 点赞被收到后（病例/动态），points 增加（质量信号）

---

## F. 失败时记录信息（方便快速定位）

如果出问题，建议你记录：
- 你访问的 Netlify 地址
- `/health.html` 的截图
- 控制台报错（浏览器开发者工具 Console）
- Supabase Auth → Logs 中对应时间段的记录（如果有）


---

## F. 社区动态 Moments（发布 / 编辑 / 点赞 / 留言）

- [ ] 登录后可以发布纯文本动态
- [ ] 登录后可以发布：文本 + 图片（拖拽 / 选择文件 / Ctrl+V 粘贴截图）
- [ ] 登录后可以发布：文本 + 短视频（≤50MB）
- [ ] 发布后：电脑端/手机端都能看到自己的动态
- [ ] 编辑动态：作者可编辑内容/图片/视频，保存后刷新仍正确
- [ ] 删除动态：作者/管理员删除后列表不再显示（网络不再 403）
- [ ] 点赞/取消点赞：计数正确、刷新后状态正确
- [ ] 留言：任意登录用户可在动态下留言
- [ ] 回复：作者可回复任意留言（显示“作者”标识）
- [ ] 留言删除：留言作者可删；动态作者/管理员也可删除该动态下留言

---

## G. 管理后台（Admin Console）

- [ ] 管理员/超级管理员登录后可以打开 `admin.html`
- [ ] 非管理员账号打开 `admin.html` 会看到”无权限提示”，且无法写入数据库
- [ ] 会议与活动：在 `admin.html#events` 新增/编辑会议后，`events.html` 页面同步更新
- [ ] 临床研究中心：在 `admin.html#research` 更新”中心信息”后，`research.html` 页面同步更新
- [ ] 研究项目库：新增项目后，公开项目库显示；隐藏后不显示

---

## H. 付费系统（Commerce · v2026-03-23）

### H1. 数据库前置

- [ ] 已运行 `migration_20260322_unified_commerce.sql`（商品/订单/权益/项目主表）
- [ ] 已运行 `migration_20260323_paid_system.sql`（视频付费字段 + RPC + 种子数据）
- [ ] Supabase API schema 已 Reload（Dashboard → API → Reload）
- [ ] `payment_proofs` bucket 已创建（非公开）
- [ ] 收款码和银行信息已在 `admin-commerce.html` → 系统配置 中填写

### H2. 免费视频不受影响

- [ ] 现有免费视频（`is_paid = false`）登录后仍可直接播放，无任何额外弹窗
- [ ] `videos.html` 中免费视频无”付费”标签
- [ ] `learning.html` 中原有文章/PPT/视频库入口正常显示

### H3. 付费视频鉴权

- [ ] 将某视频 `is_paid` 设为 `true` 后，`videos.html` 卡片显示「付费」标签
- [ ] 未登录用户点击购买显示「登录后购买」
- [ ] 已登录未购用户点击「购买单集」跳转 `checkout.html` 并显示正确商品
- [ ] 已登录未购用户直接访问 `watch.html?id=xxx` 显示购买引导，不显示播放器
- [ ] 管理员通过订单后，用户刷新 `watch.html` 可正常播放
- [ ] 有专科 Bundle 权限的用户可播放该专科所有付费视频

### H4. 结账流程

- [ ] `checkout.html?product=ICU-REG-FULL-2026` 正确显示商品名称、价格、划线原价
- [ ] Step 1 「确认下单」→ `orders` 表写入一条 `pending_payment` 记录
- [ ] Step 2 选择支付方式，显示正确的收款码（微信/支付宝）或银行信息
- [ ] Step 3 上传付款凭证 → `payment_proofs` 写入，`orders.status` 变为 `pending_review`
- [ ] 同一笔订单重复上传凭证不报错（写入新的 proof 记录即可）

### H5. 后台审核

- [ ] `admin-commerce.html` → 订单审核 Tab 显示 `pending_review` 状态订单
- [ ] 点击订单可查看付款截图
- [ ] 点「通过」→ `orders.status = approved` + `user_entitlements` 自动写入（幂等）
- [ ] 同一订单重复点「通过」第二次提示”状态不符，无法审批”（幂等保护）
- [ ] 点「驳回」→ `orders.status = rejected`，`user_entitlements` 无写入

### H6. 我的学习

- [ ] 用户菜单下拉出现「我的学习」入口
- [ ] 购买通过后，`my-learning.html` → 「我的权益」Tab 显示新权益，含有效期
- [ ] 「我的订单」Tab 显示历史订单及状态（含通过/驳回状态）
- [ ] 待审核订单显示「等待管理员审核」提示
- [ ] 有报名记录后，「已报名项目」Tab 显示项目名 + 班期 + 状态

### H7. 培训项目

- [ ] `learning.html` 培训项目区块从数据库动态加载（非硬编码）
- [ ] 草稿状态项目不显示报名按钮，显示「报名即将开放」
- [ ] 招募中项目显示报名版/视频版两个购买按钮，含早鸟价划线
- [ ] 已报名用户在项目卡片处看到「已报名」状态而非购买按钮
- [ ] `admin-commerce.html` → 项目中心：可新建/编辑项目和班期
- [ ] 班期微信群二维码仅在 `enrollment_status = confirmed` 且 `approval_status = approved` 时显示

### H8. 单视频累计升级

- [ ] 单视频总消费 ≥ 专科 Bundle 价格时，`check_video_auto_upgrade` 自动授予 Bundle 权益
- [ ] 升级后 `user_entitlements` 中出现 `grant_reason = auto_upgrade_from_singles`
- [ ] 升级后 `audit_logs` 中有对应记录

### H9. 安全与权限

- [ ] 非管理员无法访问 `admin-commerce.html`（显示无权限提示）
- [ ] 所有权限判断均来自后端 RPC（`check_video_access`、`check_project_access`），不可绕过
- [ ] `payment_proofs` bucket 为非公开，直接猜测 URL 无法访问他人凭证

