#!/usr/bin/env bash
# 别让吗喽掉进 Bug · 一键启动
# 用法：bash start.sh [端口]   （默认 8080，浏览器会自动打开）
set -e
cd "$(dirname "$0")"
PORT="${1:-8080}"

python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null" EXIT
sleep 1

URL="http://localhost:$PORT"
echo "🐵 别让吗喽掉进 Bug 已启动: $URL"
echo "（getUserMedia 要求 localhost 或 HTTPS，本机打开即可；Ctrl+C 退出）"
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true

wait $SERVER_PID
