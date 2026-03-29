#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8787}
echo "Starting AgentSouls on http://127.0.0.1:${PORT}"
exec node server.js
