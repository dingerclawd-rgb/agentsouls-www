#!/usr/bin/env bash
set -euo pipefail
TUNNEL_NAME=${1:-agentsouls-www}
PORT=${PORT:-8787}
cd "$(dirname "$0")/.."
if ! lsof -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  nohup PORT=${PORT} node server.js > /tmp/agentsouls-server.log 2>&1 &
  sleep 1
fi
exec cloudflared tunnel run "${TUNNEL_NAME}"
