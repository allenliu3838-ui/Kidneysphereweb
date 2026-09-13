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

截图未列明第五站点，不能补猜其路径。本次运行器只允许写主站八个指定文件。

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
