#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8793}"
DB_PATH="${DB_PATH:-$ROOT_DIR/data/agentsouls-v03-smoke.db}"
BASE_URL="http://127.0.0.1:${PORT}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -f "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal"

(
  cd "$ROOT_DIR"
  PORT="$PORT" DB_PATH="$DB_PATH" RATE_LIMIT_MAX=1000 node server.js >/tmp/agentsouls-v03-smoke.log 2>&1
) &
SERVER_PID=$!

for _ in {1..40}; do
  if curl -sS "$BASE_URL/api/top10" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Create 11 souls to test hourly limit easily
SOUL_IDS=()
for i in {1..11}; do
  resp=$(curl -sS -X POST "$BASE_URL/api/souls" \
    -H 'Content-Type: application/json' \
    -d "{\"agent_id\":\"owner-$i\",\"soul\":\"soul-$i\",\"tags\":[\"test\"]}")
  id=$(echo "$resp" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.data.id));});")
  SOUL_IDS+=("$id")
done

# Same soul 24h duplicate should be blocked
first_vote=$(curl -sS -X POST "$BASE_URL/api/votes" \
  -H 'Content-Type: application/json' \
  -d "{\"voter_agent_id\":\"dup-voter\",\"soul_id\":${SOUL_IDS[0]},\"vote\":1,\"comment\":\"first\"}")

dup_code=$(curl -sS -o /tmp/dup-vote.json -w "%{http_code}" -X POST "$BASE_URL/api/votes" \
  -H 'Content-Type: application/json' \
  -d "{\"voter_agent_id\":\"dup-voter\",\"soul_id\":${SOUL_IDS[0]},\"vote\":1,\"comment\":\"dup\"}")

if [[ "$dup_code" != "429" ]]; then
  echo "[FAIL] same soul 24h rule expected 429, got $dup_code"
  cat /tmp/dup-vote.json
  exit 1
fi

echo "[PASS] same soul 24h limit"

# Hourly limit: same voter votes 10 times on different souls then 11th blocked
for i in {0..9}; do
  curl -sS -X POST "$BASE_URL/api/votes" \
    -H 'Content-Type: application/json' \
    -d "{\"voter_agent_id\":\"hourly-voter\",\"soul_id\":${SOUL_IDS[$i]},\"vote\":1}" >/dev/null
done

hourly_code=$(curl -sS -o /tmp/hourly-vote.json -w "%{http_code}" -X POST "$BASE_URL/api/votes" \
  -H 'Content-Type: application/json' \
  -d "{\"voter_agent_id\":\"hourly-voter\",\"soul_id\":${SOUL_IDS[10]},\"vote\":1}")

if [[ "$hourly_code" != "429" ]]; then
  echo "[FAIL] hourly voter limit expected 429, got $hourly_code"
  cat /tmp/hourly-vote.json
  exit 1
fi

echo "[PASS] hourly voter limit"

# Verify raw/fair api available
raw_json=$(curl -sS "$BASE_URL/api/top10?mode=raw")
fair_json=$(curl -sS "$BASE_URL/api/top10?mode=fair")

echo "$raw_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.mode!=='raw')process.exit(2);if(!Array.isArray(j.data))process.exit(3);});"
echo "$fair_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.mode!=='fair')process.exit(2);if(!Array.isArray(j.data))process.exit(3);});"

echo "[PASS] /api/top10 raw/fair"

echo "=== smoke-v03 summary ==="
echo "duplicate vote status: $dup_code"
echo "hourly limit status: $hourly_code"
raw_sample=$(echo "$raw_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.data[0]||{};console.log(JSON.stringify({mode:j.mode,agent_id:r.agent_id,raw_votes:r.raw_votes,fair_score:r.fair_score}));});')
fair_sample=$(echo "$fair_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.data[0]||{};console.log(JSON.stringify({mode:j.mode,agent_id:r.agent_id,raw_votes:r.raw_votes,fair_score:r.fair_score}));});')
echo "raw sample: $raw_sample"
echo "fair sample: $fair_sample"

echo "[OK] smoke-v03 done"
