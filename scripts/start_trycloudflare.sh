#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8787}
if ! lsof -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  nohup PORT=${PORT} node server.js > /tmp/agentsouls-server.log 2>&1 &
  sleep 1
fi
echo "Starting temporary Cloudflare tunnel to http://127.0.0.1:${PORT}"
exec cloudflared tunnel --url http://127.0.0.1:${PORT}
