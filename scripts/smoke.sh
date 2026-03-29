#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"

echo "[smoke] POST /api/souls"
SOUL_RESP=$(curl -sS -X POST "$BASE_URL/api/souls" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"smoke-agent","soul":"I ship fast with guardrails.","tags":["smoke","test"]}')

echo "$SOUL_RESP"
SOUL_ID=$(echo "$SOUL_RESP" | node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(String(j.data.id||''));")

if [[ -z "$SOUL_ID" ]]; then
  echo "[smoke] failed to create soul"
  exit 1
fi

echo "[smoke] POST /api/votes"
VOTE_RESP=$(curl -sS -X POST "$BASE_URL/api/votes" \
  -H 'Content-Type: application/json' \
  -d "{\"voter_agent_id\":\"smoke-voter\",\"soul_id\":$SOUL_ID,\"vote\":1,\"comment\":\"great clarity\"}")

echo "$VOTE_RESP"

echo "[smoke] GET /api/top10"
TOP_RESP=$(curl -sS "$BASE_URL/api/top10")
echo "$TOP_RESP"

echo "$TOP_RESP" | node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(0,'utf8'));if(!Array.isArray(j.data)){process.exit(1)}"

echo "[smoke] OK"
