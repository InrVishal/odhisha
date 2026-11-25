#!/usr/bin/env bash
# The network part of a request from this runner to a deployment, measured
# without the app: which Vercel edge the runner reaches, and time to first
# byte on a reused connection (as k6 reuses them) for
#   /robots.txt   a static file served from Vercel's edge cache (no function)
#   /api/health   a function that runs one "select 1"
#
#   TARGET=https://... VERCEL_AUTOMATION_BYPASS_SECRET=... bash tools/load/network.sh
set -euo pipefail
: "${TARGET:?TARGET is required}"
H=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET:-}")

id=$(curl -sS -o /dev/null -D - "${H[@]}" "$TARGET/robots.txt" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-vercel-id"{print $2}')
# x-vercel-id is <edge region>::[<function region>::]<request id>; print only the regions.
echo "edge this runner reaches: ${id%%::*}"
fid=$(curl -sS -o /dev/null -D - "${H[@]}" "$TARGET/api/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-vercel-id"{print $2}')
echo "function region: $(echo "$fid" | awk -F'::' '{print $(NF-1)}')"

stats() {
  # 40 requests on one connection; the first (connection setup) is dropped.
  local path=$1 urls=()
  # -o applies to one URL each, so every URL gets its own.
  for _ in $(seq 1 40); do urls+=(-o /dev/null "$TARGET$path"); done
  curl -sS "${H[@]}" -w "%{time_starttransfer}\n" "${urls[@]}" | tail -n +2 | sort -n |
    awk -v p="$path" '{v[NR]=$1*1000} END{printf "%-12s time to first byte, reused connection: p50 %.0f ms, p95 %.0f ms (n=%d)\n", p, v[int(NR*0.5)+1], v[int(NR*0.95)], NR}'
}
stats /robots.txt
stats /api/health
