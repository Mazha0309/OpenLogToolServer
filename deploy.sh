#!/bin/bash
set -e

# OpenLogTool Server 一键部署脚本
# 用法: bash deploy.sh [server_port]

PORT="${1:-3000}"
PROJECT_DIR="$HOME/OpenLogToolServer"

echo "=== 1. 检查 Node.js ==="
if ! command -v node &>/dev/null; then
  echo "请先安装 Node.js (>=18):"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
  echo "  apt install -y nodejs"
  exit 1
fi
echo "Node.js $(node -v)"

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
