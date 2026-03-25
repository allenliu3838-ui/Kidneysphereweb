#!/usr/bin/env bash
# ──────────────────────────────────────────────
# 阿里云 ECS 首次部署设置脚本
# 在服务器上执行: bash setup-server.sh
# ──────────────────────────────────────────────
set -euo pipefail

echo "🔧 安装 Nginx..."
if command -v apt &>/dev/null; then
  apt update && apt install -y nginx
elif command -v yum &>/dev/null; then
  yum install -y nginx
fi

echo "📁 创建网站目录..."
mkdir -p /var/www/kidneysphere

echo "📝 安装 Nginx 配置..."
# 复制 nginx.conf 到 sites 目录
if [ -d /etc/nginx/sites-available ]; then
  # Ubuntu/Debian
  cp /var/www/kidneysphere/deploy/nginx.conf /etc/nginx/sites-available/kidneysphere
  ln -sf /etc/nginx/sites-available/kidneysphere /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
elif [ -d /etc/nginx/conf.d ]; then
  # CentOS/Alibaba Cloud Linux
  cp /var/www/kidneysphere/deploy/nginx.conf /etc/nginx/conf.d/kidneysphere.conf
fi

echo "✅ 测试 Nginx 配置..."
nginx -t

echo "🚀 启动 Nginx..."
systemctl enable nginx
systemctl restart nginx

echo ""
echo "✅ 服务器配置完成！"
echo "   网站目录: /var/www/kidneysphere"
echo "   下一步: 从本地运行 deploy.sh 同步文件"
echo ""
echo "   之后配置 HTTPS:"
echo "   1. 阿里云控制台申请免费 SSL 证书"
echo "   2. 下载证书放到 /etc/nginx/ssl/"
echo "   3. 在 nginx.conf 中启用 443 监听"
