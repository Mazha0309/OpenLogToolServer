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
  echo "请先安装 Node.js (>=24.18):"
  exit 1
fi
echo "Node.js $(node -v)"

if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 24 || (major === 24 && minor >= 18) ? 0 : 1);
'; then
  echo "需要 Node.js >=24.18"
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

echo "=== 5. 构建管理前端 ==="
cd web && npm ci --jobs=1 && npm run build && cd ..

echo "=== 6. 构建安全 Liveshare 页面 ==="
cd live && npm ci --jobs=1 && npm run build && cd ..

echo "=== 7. 配置服务端密钥 ==="
touch .env

read_env_value() {
  node -e '
    const fs = require("fs");
    const dotenv = require("dotenv");
    const parsed = dotenv.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(parsed[process.argv[2]] || "");
  ' .env "$1"
}

write_env_value() {
  local name="$1"
  local value="$2"
  if grep -Eq "^[[:space:]]*${name}[[:space:]]*=" .env; then
    sed -i -E "s|^[[:space:]]*${name}[[:space:]]*=.*$|${name}=${value}|" .env
  else
    echo "${name}=${value}" >> .env
  fi
}

ensure_secret() {
  local name="$1"
  local minimum_bytes="$2"
  local generated_bytes="$3"
  local value
  local actual_bytes

  value="$(read_env_value "$name")"
  if [ -z "$value" ]; then
    value="$(node -e '
      const { randomBytes } = require("crypto");
      process.stdout.write(randomBytes(Number(process.argv[1])).toString("hex"));
    ' "$generated_bytes")"
    write_env_value "$name" "$value"
    echo "已生成 ${name}"
    return
  fi

  actual_bytes="$(node -e '
    process.stdout.write(String(Buffer.byteLength(process.argv[1], "utf8")));
  ' "$value")"
  if [ "$actual_bytes" -lt "$minimum_bytes" ]; then
    echo "${name} 已存在但只有 ${actual_bytes} 字节，至少需要 ${minimum_bytes} 字节；为避免静默轮换，部署已停止。"
    exit 1
  fi
}

ensure_secret JWT_SECRET 32 32
ensure_secret ADMIN_BOOTSTRAP_TOKEN 24 24
ensure_secret INVITE_HMAC_KEY 32 32
ensure_secret PUBLIC_SHARE_HMAC_KEY 32 32

if ! grep -q '^PORT=' .env; then
  echo "PORT=$PORT" >> .env
fi
if ! grep -q '^NODE_ENV=' .env; then
  echo "NODE_ENV=production" >> .env
fi
chmod 600 .env

echo "=== 8. 启动服务 ==="
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
echo "Public Liveshare: http://localhost:$PORT/live/<share-id>#token=<secret>"
echo ""
echo "首次初始化管理员需要使用 .env 中的 ADMIN_BOOTSTRAP_TOKEN"
