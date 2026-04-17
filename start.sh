#!/bin/bash
echo "正在启动 OpenLogToolServer..."
cd "$(dirname "$0")"
[ ! -d "node_modules" ] && npm install
[ ! -d "web/node_modules" ] && (cd web && npm install && cd ..)
echo "🚀 启动后端..."
npm run dev &
BACKEND_PID=$!
echo "🌐 启动 Web UI..."
(cd web && npm run dev) &
WEB_PID=$!
echo ""
echo "╔══════════════════════════════════════════════════════════════╗
║                    OpenLogToolServer                        ║
╠══════════════════════════════════════════════════════════════╣
║  🌐 Web UI:     http://localhost:3001                        ║
║  📡 API:        http://localhost:3000/api/v1                   ║
║  📖 API 文档:   http://localhost:3000/api/v1/health           ║
╠══════════════════════════════════════════════════════════════╣
║  👤 管理员账号: admin                                        ║
║  🔑 管理员密码: admin123                                     ║
╚══════════════════════════════════════════════════════════════╝"
echo "按 Ctrl+C 停止所有服务"
wait
