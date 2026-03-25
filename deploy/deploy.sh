#!/usr/bin/env bash
# ──────────────────────────────────────────────
# 肾域网站部署脚本 — rsync 到阿里云 ECS
# 用法: ./deploy/deploy.sh [user@ip]
# 示例: ./deploy/deploy.sh root@47.96.xx.xx
# ──────────────────────────────────────────────
set -euo pipefail

# ── 配置 ──
REMOTE="${1:?用法: $0 user@server_ip}"
REMOTE_DIR="/var/www/kidneysphere"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 需要排除的文件（不上传到服务器）
EXCLUDES=(
  ".git"
  "deploy/"
  "docs/"
  "netlify/"
  "netlify.toml"
  "_redirects"
  "*.sql"
  "*.md"
  "*.py"
  "package*.json"
  "node_modules/"
  ".gitignore"
  "kidneysphere_phase1_*"
  "tools_*"
)

# 构建 rsync 排除参数
EXCLUDE_ARGS=()
for pat in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=(--exclude="$pat")
done

echo "📦 部署 kidneysphere.com"
echo "   本地: $LOCAL_DIR"
echo "   远程: $REMOTE:$REMOTE_DIR"
echo ""

# 1. 确保远程目录存在
echo "🔧 确保远程目录存在..."
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"

# 2. rsync 同步
echo "🚀 同步文件..."
rsync -avz --delete \
  "${EXCLUDE_ARGS[@]}" \
  "$LOCAL_DIR/" \
  "$REMOTE:$REMOTE_DIR/"

# 3. 设置权限
echo "🔒 设置文件权限..."
ssh "$REMOTE" "chown -R www-data:www-data $REMOTE_DIR 2>/dev/null || chown -R nginx:nginx $REMOTE_DIR 2>/dev/null || true"
ssh "$REMOTE" "find $REMOTE_DIR -type f -exec chmod 644 {} \; && find $REMOTE_DIR -type d -exec chmod 755 {} \;"

# 4. 检查 Nginx 配置并重载
echo "🔄 重载 Nginx..."
ssh "$REMOTE" "nginx -t && systemctl reload nginx"

echo ""
echo "✅ 部署完成！访问 http://kidneysphere.com 查看"
