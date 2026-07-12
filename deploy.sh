#!/bin/bash
set -euo pipefail

# OpenLogTool Server 一键部署脚本
# 用法: bash deploy.sh [server_port]

PORT="${1:-3000}"
PROJECT_DIR="$HOME/OpenLogToolServer"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "端口必须是 1-65535 之间的整数"
  exit 1
fi

echo "=== 1. 检查 Node.js & npm ==="
if ! command -v node &>/dev/null; then
  echo "请先安装 Node.js (>=20):"
  exit 1
fi
echo "Node.js $(node -v)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "需要 Node.js >=20"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "请安装 npm"
  exit 1
fi

echo "=== 2. 克隆/更新代码 ==="
if [ -d "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR"
  git pull origin rewrite
else
  git clone -b rewrite https://github.com/Mazha0309/OpenLogToolServer.git "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

echo "=== 3. 安装后端依赖 ==="
npm ci --jobs=1

echo "=== 4. 编译 TypeScript ==="
npm run build

echo "=== 5. 构建前端 ==="
cd web && npm ci --jobs=1 && npm run build && cd ..
cd live && npm ci --jobs=1 && npm run build && cd ..

echo "=== 6. 配置服务端密钥 ==="
touch .env
if ! grep -q '^JWT_SECRET=' .env; then
  echo "JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" >> .env
fi
if ! grep -q '^ADMIN_BOOTSTRAP_TOKEN=' .env; then
  echo "ADMIN_BOOTSTRAP_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")" >> .env
fi
if ! grep -q '^INVITE_HMAC_KEY=' .env; then
  echo "INVITE_HMAC_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" >> .env
fi
if ! grep -q '^PORT=' .env; then
  echo "PORT=$PORT" >> .env
fi
chmod 600 .env

echo "=== 7. 启动服务 ==="
if command -v pm2 &>/dev/null; then
  pm2 describe openlogtool &>/dev/null && pm2 restart openlogtool --update-env || pm2 start dist/index.js --name openlogtool
  pm2 save
  echo "已通过 pm2 启动"
else
  # 杀掉旧进程
  kill $(lsof -ti:$PORT) 2>/dev/null || true
  sleep 1
  nohup node dist/index.js > server.log 2>&1 &
  echo "PID: $!  日志: server.log"
fi

echo ""
echo "=== 部署完成 ==="
echo "服务器: http://localhost:$PORT"
echo "管理后台: http://localhost:$PORT/admin"
echo "Liveshare: http://localhost:$PORT/live/<sessionId>"
echo ""
echo "首次初始化管理员需要使用 .env 中的 ADMIN_BOOTSTRAP_TOKEN"
