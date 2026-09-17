# 阿里云双站更新说明（2026-09-18）

适用于当前已经运行网站的 Ubuntu 24.04 服务器。截图里的 `/root/kidneysphere-*` 是多轮发布目录，不能仅凭目录名称判定线上使用哪一份。本文没有执行上线。

## 第一步：在阿里云终端检查现状

复制执行以下命令并反馈输出。这些命令只读取状态，不修改网站：

```bash
nginx -T 2>/dev/null | awk '/^# configuration file / || /^[[:space:]]*(listen|server_name|root|alias)[[:space:]]/ {print}'
node --version
npm --version
ls -ld /var/www/kidneysphere /var/www/kidneysphere-doctor /var/www/kidneysphere-doctor/dist
git -C /var/www/kidneysphere-doctor rev-parse HEAD
git -C /var/www/kidneysphere-doctor status --short --untracked-files=no
```

路径不存在或不是 Git 仓库时，保留错误输出，不要创建空目录。不要发送 `.env`、私钥或完整环境变量。

完整版本检查可将同目录 `aliyun-readonly-check.py` 上传到 `/root/` 后执行 `python3 /root/aliyun-readonly-check.py`。路径不同可指定 `--portal-root` 和 `--doctor-root`。脚本只输出 Nginx 路由、Git 提交/状态、公开 build_id、11 个门户文件校验值及必要依赖是否存在。`unrecognized_do_not_overwrite` 表示尚未核对的线上版本，须先保留并比较其修改。

## 本轮候选运行代码

| 项目 | 固定提交 | 历史生产位置，需实际确认 |
| --- | --- | --- |
| 学习门户 PR #186 | `7a5b5227457125b3410a0865520ab36d55b56699` | `/var/www/kidneysphere` |
| 医生端 PR #40 | `e28760e2f0695785822962632844799d8645031d` | `/var/www/kidneysphere-doctor/dist` |

PR 仍为草稿。后续仅文档提交可能改变分支 HEAD；发布固定上表运行代码版本，不自动取变化中的分支。

共享数据库中的题库纠错和下架无需重部署网页；完整题干、分页、计分及导入修复需要发布本轮前端代码。

## 核对现状后的发布步骤

1. 记录真实 Nginx root、当前提交/build_id、文件权限与校验值；将现状备份到网站根目录之外的独立时间戳目录，保留手工修改。
2. 医生端在新目录取得固定提交，使用 Node 22 和 `npm ci`，失败即停止。运行 `npm test`、`npm run test:integration`、`./node_modules/.bin/tsc --noEmit`。构建：

   ```bash
   COMMIT_REF=e28760e2f0695785822962632844799d8645031d npm run build
   ```

   核对 `dist/build.json` 的 build_id 为 `e28760e2`。保留实际公开构建配置，服务端密钥不得复制进前端产物。
3. 先发布医生静态输出。核实 `dist` 是目录还是符号链接，再选择对应的切换/恢复命令；保留旧缓存页面仍会引用的 hash 静态资源。若网页实际由 PM2 提供，应先确认进程配置，不能套用 Nginx 静态切换。此次前端修复本身无需修改 API 服务或密钥。
4. 门户仅按清单更新 11 个运行文件：`app.js`、`index.html`、`portal-home.css`、`qbank-data.js`、`qbank.js`、`qbank-test.js`、`qbank-parser.js`、`qbank-admin.js`、`qbank.html`、`qbank-test.html`、`qbank-admin.html`。先 JS/CSS 依赖，后 HTML。旧校验值未知时先合并，确认已有图片及其他依赖齐全，不整站覆盖。
5. 验收本机与公网 build_id、首页、AI/工具、完整病例题干、全部题库和返回上一题的计分。使用已有测试账号检查我的学习和已购课程。题库 HTML 已更新脚本版本参数；历史其他页面可能仍缓存旧 app.js，需结合实际缓存策略确认。

## 回滚

医生端恢复记录的旧静态版本或链接指向，核对原 build_id。门户恢复本轮实际旧文件；新增的 `qbank-data.js` 仅在确认原来不存在且当前仍为本轮文件时移除。恢复前核对当前文件仍为本轮版本，避免覆盖后续编辑。

数据库题目内容单独有原文和逐题修改记录；前端回滚不会恢复已下架题目。

## 为什么不直接运行旧部署脚本

门户旧脚本有 `rsync --delete`，会影响本轮清单以外的文件。医生端旧脚本会 reset 到动态分支，`SKIP_NGINX=1` 仍可能重载 PM2；依赖安装失败会回退 `npm install`，健康检查失败仅警告，且 `dist.prev` 只保留一份。当前有多轮手工发布，先取得第一步实际输出，再确定匹配现状的应用和回滚命令。
