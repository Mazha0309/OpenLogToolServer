#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

show_usage() {
    echo "OpenLogTool Server - Docker/Podman 部署脚本"
    echo ""
    echo "用法: $0 <命令>"
    echo ""
    echo "命令:"
    echo "  start       启动服务器（内存数据库）"
    echo "  start:mysql 启动服务器（MySQL 数据库）"
    echo "  start:mongo 启动服务器（MongoDB 数据库）"
    echo "  stop        停止所有容器"
    echo "  restart     重启所有容器"
    echo "  logs        查看日志"
    echo "  clean       删除所有容器和数据卷"
    echo ""
}

detect_compose() {
    if command -v docker &> /dev/null; then
        if command -v docker compose &> /dev/null; then
            COMPOSE_CMD="docker compose"
        elif docker-compose version &> /dev/null; then
            COMPOSE_CMD="docker-compose"
        else
            echo "错误: Docker 已安装但未找到 compose"
            exit 1
        fi
    elif command -v podman &> /dev/null; then
        if command -v podman-compose &> /dev/null; then
            COMPOSE_CMD="podman-compose"
        elif podman compose version &> /dev/null; then
            COMPOSE_CMD="podman compose"
        else
            echo "错误: Podman 已安装但未找到 compose 插件"
            echo "请安装 podman-compose: pip install podman-compose"
            exit 1
        fi
    else
        echo "错误: 未找到 Docker 或 Podman"
        exit 1
    fi
}

COMPOSE_CMD=""

start_server() {
    echo "正在启动 OpenLogTool Server..."
    cd "$SCRIPT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
    echo ""
    echo "服务器已启动!"
    echo "  API:     http://localhost:3000/api/v1"
    echo "  Web UI: http://localhost:3000"
    echo "  管理员: admin / admin123"
}

start_mysql() {
    echo "正在启动 OpenLogTool Server + MySQL..."
    cd "$SCRIPT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" --profile mysql up -d
    echo ""
    echo "服务器 + MySQL 已启动!"
    echo "  API:     http://localhost:3000/api/v1"
    echo "  Web UI:  http://localhost:3000"
    echo "  MySQL:   localhost:3306"
    echo "  管理员:  admin / admin123"
}

start_mongo() {
    echo "正在启动 OpenLogTool Server + MongoDB..."
    cd "$SCRIPT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" --profile mongodb up -d
    echo ""
    echo "服务器 + MongoDB 已启动!"
    echo "  API:     http://localhost:3000/api/v1"
    echo "  Web UI:  http://localhost:3000"
    echo "  MongoDB: localhost:27017"
    echo "  管理员:  admin / admin123"
}

stop_server() {
    echo "正在停止 OpenLogTool Server..."
    cd "$SCRIPT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" down
}

restart_server() {
    echo "正在重启 OpenLogTool Server..."
    cd "$SCRIPT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" restart
}

show_logs() {
    cd "$SCRIPT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" logs -f
}

clean_all() {
    echo "警告: 这将删除所有数据!"
    read -p "确定要继续吗? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        cd "$SCRIPT_DIR"
        $COMPOSE_CMD -f "$COMPOSE_FILE" down -v
        echo "已删除所有数据。"
    else
        echo "已取消。"
    fi
}

detect_compose

case "${1:-}" in
    start)
        start_server
        ;;
    start:mysql)
        start_mysql
        ;;
    start:mongo)
        start_mongo
        ;;
    stop)
        stop_server
        ;;
    restart)
        restart_server
        ;;
    logs)
        show_logs
        ;;
    clean)
        clean_all
        ;;
    *)
        show_usage
        ;;
esac