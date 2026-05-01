#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────
# OpenLogToolServer - 启动脚本
# ──────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

MODE="${1:-dev}"
BACKEND_PORT="${PORT:-3000}"
WEB_PORT="${WEB_PORT:-3001}"
PIDS=()

# ── 工具函数 ──────────────────────────────────

log()    { echo -e "${GREEN}[✓]${NC} $*"; }
warn()   { echo -e "${YELLOW}[!]${NC} $*"; }
error()  { echo -e "${RED}[✗]${NC} $*"; }
info()   { echo -e "${BLUE}[i]${NC} $*"; }
header() { echo -e "\n${CYAN}─── $* ───${NC}"; }

cleanup() {
    echo ""
    warn "正在停止所有服务..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
    done
    log "所有服务已停止"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# ── 环境检查 ──────────────────────────────────

header "环境检查"

for cmd in node npm; do
    if ! command -v "$cmd" &>/dev/null; then
        error "$cmd 未找到，请先安装 Node.js"
        exit 1
    fi
done

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    error "需要 Node.js >= 18，当前版本: $(node -v)"
    exit 1
fi
log "Node.js $(node -v)"

if [ ! -f ".env" ]; then
    warn ".env 文件不存在，从 .env.example 复制默认配置"
    cp .env.example .env
    log "已创建 .env"
fi

source_env() {
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
}

source_env

DB_TYPE="${DB_TYPE:-memory}"
info "数据库类型: ${DB_TYPE}"
info "后端端口:   ${BACKEND_PORT}"

# ── 端口检查 ──────────────────────────────────

port_in_use() {
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep -q ":${1} " && return 0
    elif command -v netstat &>/dev/null; then
        netstat -tlnp 2>/dev/null | grep -q ":${1} " && return 0
    elif command -v lsof &>/dev/null; then
        lsof -i :"${1}" &>/dev/null && return 0
    fi
    return 1
}

if port_in_use "$BACKEND_PORT"; then
    error "端口 ${BACKEND_PORT} 已被占用，请先停止占用进程"
    warn "查找占用进程: lsof -i :${BACKEND_PORT}"
    exit 1
fi

if [ "$MODE" = "dev" ] && port_in_use "$WEB_PORT"; then
    error "端口 ${WEB_PORT} 已被占用，请先停止占用进程"
    exit 1
fi

log "端口 ${BACKEND_PORT}/${WEB_PORT} 可用"

# ── 依赖安装 ──────────────────────────────────

header "依赖检查"

if [ ! -d "node_modules" ]; then
    info "安装后端依赖..."
    npm install --silent
fi
log "后端依赖就绪"

if [ "$MODE" = "dev" ] && [ ! -d "web/node_modules" ]; then
    info "安装前端依赖..."
    (cd web && npm install --silent)
fi
log "前端依赖就绪"

# ── 数据库检查 ──────────────────────────────────

header "数据库状态"

check_db() {
    case "$DB_TYPE" in
        mysql)
            if ! command -v mysql &>/dev/null; then
                warn "MySQL 客户端未安装，跳过连接检查"
                return 1
            fi
            mysql -h "${DB_HOST:-localhost}" -P "${DB_PORT:-3306}" \
                  -u "${DB_USER:-root}" ${DB_PASSWORD:+-p"$DB_PASSWORD"} \
                  -e "SELECT 1" "${DB_NAME:-openlogtool}" &>/dev/null && return 0 || return 1
            ;;
        mongodb)
            local mongo_host="${DB_HOST:-127.0.0.1}"
            local mongo_port="${DB_PORT:-27017}"
            if ! port_in_use "$mongo_port"; then
                warn "MongoDB 端口 ${mongo_port} 未监听 (${mongo_host})"
                return 1
            fi
            log "MongoDB 端口 ${mongo_port} 已监听 (${mongo_host})"
            if command -v mongosh &>/dev/null; then
                mongosh --quiet --eval "db.runCommand({ping:1})" \
                    "mongodb://${mongo_host}:${mongo_port}/${DB_NAME:-openlogtool}" &>/dev/null && return 0
            elif command -v mongo &>/dev/null; then
                mongo --quiet --eval "db.runCommand({ping:1})" \
                    "mongodb://${mongo_host}:${mongo_port}/${DB_NAME:-openlogtool}" &>/dev/null && return 0
            fi
            return 0
            ;;
        memory)
            return 0
            ;;
        *)
            warn "未知数据库类型: $DB_TYPE，将使用内存数据库"
            return 0
            ;;
    esac
}

if check_db; then
    log "数据库连接正常 (${DB_TYPE})"
else
    info "无法验证数据库连接，将由后端在启动时连接 (${DB_TYPE})"
fi

# ── 启动服务 ──────────────────────────────────

header "启动服务"

# 后端
info "启动后端 (nodemon) → http://localhost:${BACKEND_PORT}"
npx nodemon server/index.js &
PIDS+=($!)
sleep 2

# 前端 (仅 dev 模式)
if [ "$MODE" = "dev" ]; then
    info "启动 Web UI (Vite) → http://localhost:${WEB_PORT}"
    (cd web && npx vite --host) &
    PIDS+=($!)
    sleep 1
else
    info "生产模式：后端直接提供 Web UI (http://localhost:${BACKEND_PORT})"
fi

# ── 显示信息 ──────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              OpenLogToolServer 已启动                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"

if [ "$MODE" = "dev" ]; then
    echo "║  🌐 Web UI  (Vite): http://localhost:${WEB_PORT}                ║"
    echo "║  📡 API:            http://localhost:${BACKEND_PORT}/api/v1      ║"
else
    echo "║  🌐 Web UI + API:   http://localhost:${BACKEND_PORT}            ║"
fi

echo "║  💚 健康检查:        http://localhost:${BACKEND_PORT}/api/v1/health║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  数据库: ${DB_TYPE}                                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  👤 管理员: admin / admin123                                 ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  按 Ctrl+C 停止                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

info "等待服务就绪..."

# ── 健康检查轮询 ──────────────────────────────────

MAX_RETRIES=30
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -sf "http://localhost:${BACKEND_PORT}/api/v1/health" > /dev/null 2>&1; then
        log "后端已就绪 ✓"
        break
    fi
    RETRY=$((RETRY + 1))
    sleep 1
done

if [ $RETRY -ge $MAX_RETRIES ]; then
    warn "后端启动超时，请检查日志"
fi

# ── 等待退出 ──────────────────────────────────

wait
