#!/usr/bin/env bash
# Runs the k6 load test against N local production-mode app processes.
#
#   bash tools/load/run.sh <processes> <summary.json> [extra k6 flags...]
#
# Needs load.env and load-seed.json from tools/load/prepare-db.sh (a LOCAL
# database only) and ./k6. Each virtual user sticks to one process, the way a
# Vercel instance serves its share of requests. Never points at preview or
# production: every URL here is 127.0.0.1.
set -euo pipefail
N="${1:?number of app processes}"
SUMMARY="${2:?summary file}"
shift 2

set -a
# shellcheck disable=SC1091
. ./load.env
set +a
export NODE_ENV=production EMAIL_TRANSPORT=console RATE_LIMIT_BACKEND=memory

PIDS=()
URLS=""
for k in $(seq 0 $((N - 1))); do
  PORT=$((3400 + k))
  # Keep-alive longer than k6's 5-7 s pause between rounds; otherwise Node's
  # 5 s default closes sockets k6 is about to reuse ("connection reset").
  nohup node node_modules/next/dist/bin/next start -p "$PORT" --keepAliveTimeout 65000 > "load-server-$k.log" 2>&1 &
  PIDS+=("$!")
  URLS="${URLS:+$URLS,}http://127.0.0.1:$PORT"
done
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT

for k in $(seq 0 $((N - 1))); do
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$((3400 + k))/api/health" >/dev/null && break
    sleep 1
  done
done

echo "load: ${N} app process(es) on 127.0.0.1, database $(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).hostname + "/" + new URL(process.env.DATABASE_URL).pathname.slice(1))') as app_runtime"
./k6 run --summary-export "$SUMMARY" -e BASE_URLS="$URLS" -e SEED_FILE="$PWD/load-seed.json" "$@" tools/load/k6-load.js
