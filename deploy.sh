#!/bin/bash
set -e

# OpenLogTool Server 一键部署脚本
# 用法: bash deploy.sh [server_port]

PORT="${1:-3000}"
PROJECT_DIR="$HOME/OpenLogToolServer"

echo "=== 1. 检查 Node.js & pnpm ==="
if ! command -v node &>/dev/null; then
  echo "请先安装 Node.js (>=18):"
  exit 1
fi
echo "Node.js $(node -v)"

if command -v pnpm &>/dev/null; then
  PKG="pnpm"
  CI="pnpm install --frozen-lockfile"
  BUILD="pnpm run build"
elif command -v npm &>/dev/null; then
  PKG="npm"
  CI="npm ci --jobs=1"
  BUILD="npm run build"
else
  echo "请安装 npm 或 pnpm"
  exit 1
fi
echo "包管理器: $PKG"

echo "=== 2. 克隆/更新代码 ==="
if [ -d "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR"
  git pull origin rewrite
else
  git clone -b rewrite https://github.com/Mazha0309/OpenLogToolServer.git "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

echo "=== 3. 安装后端依赖 ==="
$CI

echo "=== 4. 编译 TypeScript ==="
$BUILD

echo "=== 5. 构建前端 ==="
cd web && $CI && $BUILD && cd ..
cd live && $CI && $BUILD && cd ..

echo "=== 6. 配置 JWT 密钥 ==="
if [ ! -f .env ]; then
  echo "JWT_SECRET=$(date +%s | sha256sum | head -c 32)" > .env
  echo "PORT=$PORT" >> .env
fi

echo "=== 7. 启动服务 ==="
if command -v pm2 &>/dev/null; then
  pm2 describe openlogtool &>/dev/null && pm2 restart openlogtool || pm2 start dist/index.js --name openlogtool
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
echo "首次使用需要在客户端注册第一个用户（自动成为 admin）"
