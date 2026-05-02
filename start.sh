#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"
echo ""
echo "  OpenLogToolServer"
echo "  URL: http://${HOST}:${PORT}"
echo ""
[ ! -d "node_modules" ] && npm install
exec node server/index.js
