#!/usr/bin/env bash
set -euo pipefail
TUNNEL_NAME=${1:-agentsouls-www}
DOMAIN=${2:-www.agentsouls.io}
PORT=${PORT:-8787}

mkdir -p ~/.cloudflared

if [ ! -f ~/.cloudflared/cert.pem ]; then
  echo "[ACTION REQUIRED] No Cloudflare cert found. Run: cloudflared tunnel login"
  exit 2
fi

if ! cloudflared tunnel list | grep -q "${TUNNEL_NAME}"; then
  cloudflared tunnel create "${TUNNEL_NAME}"
fi

cloudflared tunnel route dns "${TUNNEL_NAME}" "${DOMAIN}"
TUNNEL_ID=$(cloudflared tunnel list | awk -v n="${TUNNEL_NAME}" '$0 ~ n {print $1; exit}')

cat > ~/.cloudflared/config.yml <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: /Users/${USER}/.cloudflared/${TUNNEL_ID}.json
ingress:
  - hostname: ${DOMAIN}
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
EOF

echo "Configured named tunnel ${TUNNEL_NAME} (${TUNNEL_ID}) for ${DOMAIN} -> 127.0.0.1:${PORT}"
