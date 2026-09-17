# KidneySphere 主站首页 · 阿里云发布记录

## 当前授权与状态

用户已在新版预览验收后明确要求发布到现有阿里云服务器。此前草稿说明中的“不发布生产”描述的是上一阶段；本次已获发布授权。

当前由用户已登录的服务器终端执行。我方没有该终端的直接 SSH 会话。离线包已准备后，必须以终端执行输出和公开网站检查判断结果，不能把包准备完成称为已上线。

## 已核实的实际站点边界

依据用户提供的 `nginx -T` 筛选结果：

| 域名 | Nginx 配置 | 实际文档根目录 |
| --- | --- | --- |
| kidneysphere.com | /etc/nginx/sites-enabled/kidneysphere.com | /var/www/kidneysphere |
| kidneyspheredoctorapp.cn | /etc/nginx/conf.d/kidneyspheredoctorapp.cn.conf | /var/www/kidneysphere-doctor/dist |
| kidneysphereregistry.cn | /etc/nginx/conf.d/kidneysphereregistry.conf | /var/www/kidneysphere-registry |
| kidneysphereremote.cn | /etc/nginx/conf.d/kidneysphereremote.conf | /var/www/kidneysphere-remote |

截图未列明第五站点，不能补猜其路径。首页运行器只允许写主站八个指定文件；后续 HTTPS 运行器的独立范围见文末。

## 固定发布内容

页面来源提交：`a0b8bba3b71784533c5696f55569fe5ee073e2aa`。

按新资源在前、入口在后的顺序发布：

1. assets/portal/critical-v1.webp
2. assets/portal/pathology-v1.webp
3. assets/portal/transplant-v1.webp
4. portal-home.css
5. portal-home.js
6. home.js
7. app.js
8. index.html

不上传测试、文档、部署配置、SQL、数据库、媒体或其他站点文件。`app.js` 为主站共享脚本，因此旧文件未知漂移会阻止发布，发布后还需检查登录、视频库、我的学习和播放器入口。

## 离线包与执行

`deploy/build-portal-release.py` 从固定 Git 对象读取页面资源，生成只使用 Python 标准库的自包含 `.pyz` 文件。服务器无须安装依赖、克隆仓库或联网下载资源。包内 manifest 包含八份内容的大小、SHA256 与可识别旧版本。

用户将 `kidneysphere-home-offline-20260913.pyz` 上传到 `/root/` 后，先用交付的外部 SHA256 校验，再运行：

```bash
python3 /root/kidneysphere-home-offline-20260913.pyz --check
python3 /root/kidneysphere-home-offline-20260913.pyz --apply
```

`--check` 只读。`--apply` 重新执行前置检查，通过后备份并更新。没有忽略未知旧版本的 `--force` 参数。

## 备份与恢复

- 实际旧文件备份保存在 `/root/kidneysphere-home-releases/`，位于网站根目录之外。
- 备份记录原文件是否存在、内容校验值与文件权限/所有者。
- 普通执行异常会尝试在本次锁内恢复；断电或强制终止后使用输出中的 `ROLLBACK_COMMAND`。
- 断电/强制终止可能留下少量同目录暂存文件，八份正式资源仍可凭备份恢复；不要使用通配符批量删除文件。
- 回滚前整批核对当前文件是否仍为原值或本包值；如果发布后又被第三方修改则拒绝覆盖。
- 这是首页资源备份，不是数据库或整个服务器的快照。
- 不运行旧 `deploy/deploy.sh`，不做 `rsync --delete`，不递归改权限，不重启 Nginx 或其他服务。

## 验证与后续记录

预览阶段已完成 56 项回归、320–1440px 框架宽度检查、搜索/筛选/目录切换/手机菜单及游客观看门槛检查。发布运行器的19项临时目录安全测试通过，包括八次逐步替换故障自动恢复、旧版本漂移、缺失依赖、损坏包、符号链接、错误站点配置、磁盘不足、并发锁、损坏备份与回滚内容及权限保护；不能用这些测试代替服务器执行结果。

交付包大小：187,226 bytes。SHA256：`adfba96ae25161001dd08031fe9bf182acdb6360e38078bd7384a20d1b234e00`。

拿到终端输出后填写：实际备份目录、发布状态、公开首页和资源校验、其他站点访问结果。真实已购账号的登录播放以及 iOS/Android/微信真机体验仍需独立验收。

## 终端与域名核验结果（2026-09-13 UTC）

用户提供的终端输出确认，首页发布包返回 `NO_CHANGE: all eight resources already match this release`。本机使用 `Host: kidneysphere.com` 请求 `http://127.0.0.1/index.html`，已返回新版标题“KidneySphere 肾域｜肾脏专科视频课程与培训报名”。这证明阿里云目录和本机 HTTP 首页已就绪；尚未收到首页包第一次实际应用的备份路径，不能填写推测的备份目录。

公网此前仍显示旧首页的原因已确认：域名指向 Netlify。用户终端查询的地址为 `75.2.60.5`，公网响应含 `server: Netlify` 和 `x-nf-request-id`。独立浏览器使用新的查询参数加载后仍见旧版 HTML，不能归因于用户本机缓存。

Cloudflare 是当前 DNS 服务商，用户截图中的门户记录均为 DNS only：

| 记录 | 类型 | 切换前内容 |
| --- | --- | --- |
| kidneysphere.com | A | 75.2.60.5 |
| www.kidneysphere.com | CNAME | wonderful-entremet-04ceeb.netlify.app |
| vod.kidneysphere.com | CNAME | vod.kidneysphere.com.w.kunlunle.com |

根域名与 www 的前两项是门户切换及 DNS 回退的对应记录。vod、MX、邮件 TXT 和其余验证记录保留。已请用户通过 Cloudflare Export 保存完整 DNS 导出，但尚未收到导出完成的证据。

用户提供的阿里云实例公网地址为 `101.132.173.150`、内网地址为 `172.24.33.51`。后续同一终端的 `hostname` 与网卡检查确认主机 `iZuf6dwmk7xr0hx3tsxbfbZ` 的 eth0 地址为 `172.24.33.51/18`，与截图对应。

本机 Nginx 代理接口检查：

- `GET /api/health` 返回 200 和 `status: ok`。
- 不带登录凭证的 `POST /api/videos/00000000-0000-0000-0000-000000000000/play-auth` 返回 401 和 `unauthorized`，符合游客访问预期。
- 以上只证明后端连通和游客校验分支，未验证实际 Supabase/VOD 配置或已购视频播放。
- 初次使用 `curl --resolve kidneysphere.com:443:127.0.0.1` 验证 HTTPS，返回证书域名不匹配。当前门户 vhost 仅监听 80，不能直接切换公网解析。

## 门户证书已签发

用户服务器已有 Certbot 2.9.0，Nginx 配置检查成功。采用只签发证书的手工 DNS-01 流程，在 Cloudflare 新增 `_acme-challenge` 与 `_acme-challenge.www` 两项 TXT 后，Certbot 已返回 `Successfully received certificate`：

- 证书域名：kidneysphere.com、www.kidneysphere.com。
- 证书链：`/etc/letsencrypt/live/kidneysphere.com/fullchain.pem`。
- 私钥留在服务器：`/etc/letsencrypt/live/kidneysphere.com/privkey.pem`，无需下载或向聊天提供其内容。
- 到期日期：2026-12-12。
- 手工签发尚未启用自动续期。后续须配置适用的自动认证方式并实际验收，不能仅凭存在 Certbot 定时器宣称完成。

## HTTPS 接入与后续切换边界

下一阶段只修改门户 vhost：保留现有 80 端口、所有 API 代理、`/auth/callback` 与静态路由，增加门户证书对应的 443 TLS 监听。新增的 `/.well-known/acme-challenge/` 静态入口使用独立目录 `/var/lib/kidneysphere-acme`，为后续 webroot 自动续期准备；这一步本身不启用续期。

HTTPS 配置必须先备份原文件与权限，使用 Nginx 配置检查、平滑重载、本机两个域名的证书验证及首页/接口检查；失败时恢复本次实际备份，拒绝覆盖之后发生的第三方配置变化。不使用关闭证书验证的 `curl -k`。

公网 DNS 切换、证书自动续期和真实已购账号播放测试仍待执行。仓库中的 Express 适配器尚未注册 Netlify 的 `/api/content*`、`/api/me`、部分 atlas API/路由及文章 SSR；这是整站切换前需要核实和处理的功能差异，不能把首页静态部署或 HTTPS 接入通过视为这些功能也已迁移。

## HTTPS 离线配置包

源码为 `deploy/portal-https.py`，由 `deploy/build-portal-https.py` 确定性打包。交付文件 `kidneysphere-https-offline-20260913.pyz`，7,072 bytes，SHA256 为 `e29e79beef221111da34c4e1d1afbb96c25cc556e3aca18dc72a16d9c401d855`。

运行器默认/`--check` 只读。`--apply` 核实机器内网地址、现有门户配置、证书域名/有效期/信任链及私钥配对后，保留原配置字节，仅插入 443 TLS 和 ACME 入口。保留合法的 sites-enabled 符号链接，并在 `/root/kidneysphere-https-releases/` 创建本次配置备份、校验值及恢复记录；不备份数据库或整台服务器。写入采用同目录暂存和原子替换，检查配置后平滑重载 Nginx。

配置不是预期的单一门户 server 块，或发现已有 TLS、include、alias、不同 root、同名 vhost 等情况时，在修改之前报错，需查看实际配置后处理。常规失败尝试恢复原配置；已有第三方改动时拒绝覆盖并提示检查。强制终止可能残留暂存文件或随机 ACME 探针，需按本次打印的恢复命令处理，不做通配符清理。

本地 19 项测试通过，覆盖临时目录中的配置范围、内容/权限/符号链接保留、只读检查、重复执行、Nginx 检查/重载失败、运行检查失败后的恢复，以及损坏备份和第三方改动保护。证书测试使用实际 OpenSSL 和临时测试证书，特别验证 hostname 不匹配时 OpenSSL 仍可能返回退出码 0，运行器必须核对明确的匹配结果。Nginx、systemctl、IP 和网络响应在测试中模拟，尚未在用户服务器执行；不能将这些测试称为实际 HTTPS 已通过。

用户上传到 `/root/` 后执行：

```bash
printf '%s  %s\n' \
  'e29e79beef221111da34c4e1d1afbb96c25cc556e3aca18dc72a16d9c401d855' \
  '/root/kidneysphere-https-offline-20260913.pyz' | sha256sum -c - &&
python3 /root/kidneysphere-https-offline-20260913.pyz --apply
```

运行器打印 `BACKUP`、可直接执行的 `ROLLBACK_COMMAND` 和最终状态。实际运行检查包含两个域名的本机 HTTPS/新版首页、健康接口、游客播放权限校验，以及两个域名通过 80/443 访问临时 ACME 探针。只有收到用户的 `HTTPS_OK` 输出后才继续公网验证；DNS 记录此时仍保留原值。

## HTTPS 验收及生态展示调整（2026-09-14）

用户终端已返回 `HTTPS_OK`，实际 HTTPS 配置备份为 `/root/kidneysphere-https-releases/20260913T182250Z-146cmu7c`。用户在收到 www 入口切换指导后确认新版可见，并提供新版生态区截图；尚未独立确认实际 DNS 记录，也未收到真实已购视频播放或自动续期验收结果。

用户新增要求：放大“证据与合作生态”，专家轮流展示，避免总是本人排第一。相应调整仅改首页的 `home.js`、`portal-home.css`、`index.html`：

- 扩大区块留白、卡片和头像，桌面端头像 112×146px，姓名20px、机构15px。宽屏3张，中屏2张，手机1张。
- 国内和国际专家合并后，每次访问轮换起点；首次随机选择，后续在该浏览器轮换至下一位。完整名单不删减，也不修改后台排序。
- 仅专家目录在可见且未暂停时每6秒前进一张，末尾回到起点。鼠标悬停临时暂停；手指接触、键盘阅读、手动翻页或展开简介后暂停，用户可通过按钮重新开始。遵守减少动态效果偏好，页面隐藏或区块移出视野时暂停。
- 通过更新 CSS/JS 查询版本使新首页加载对应资源，不改登录、视频鉴权、数据库或服务器配置。

更新包复用已验证的八文件备份/恢复运行器；其中三文件内容变化，另五文件保持相同内容但仍在整批备份与替换范围。运行器兼容上一阶段安装的精确 ACME 配置，仍拒绝未知根目录；不会修改 Nginx 或重载服务。打包来源必须是不可变 Git 提交，旧版本只接受先前已部署的首页版本和本次目标版本。

本地验证：68项首页及轮播测试、21项部署测试通过。轮播测试包含存储禁用、完整名单保留、6秒推进与末尾循环、阅读和手动操作暂停、离屏/后台暂停、减少动态效果及重复初始化；部署测试额外覆盖已安装的 ACME 入口与错误根目录拒绝。响应式预览继续使用同源首页，检查实际卡片及头像尺寸。
