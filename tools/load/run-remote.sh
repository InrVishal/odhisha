#!/usr/bin/env bash
# Runs the k6 load test from THIS machine (in India) against a deployment the
# "load-test-hold" workflow is holding (.github/workflows/load-preview.yml):
# measures what owners and buyers in India actually feel.
#
#   VERCEL_AUTOMATION_BYPASS_SECRET=... bash tools/load/run-remote.sh [<run id>]
#
# - <run id>: the held "Load test (preview)" run (default: the newest one).
# - VERCEL_AUTOMATION_BYPASS_SECRET: from Vercel -> Settings -> Deployment
#   Protection -> Protection Bypass for Automation. Set it in your own shell;
#   it is never written to disk or printed.
# - The hand-off (URL + 200 seeded accounts for a throwaway branch) is
#   decrypted with ~/.nightshift/load-hold/key.pem into a private temp folder
#   that is deleted afterwards.
# - k6 is downloaded and checked against its release checksums if not on PATH.
# Needs: gh (signed in), openssl, curl, node.
set -euo pipefail
: "${VERCEL_AUTOMATION_BYPASS_SECRET:?set VERCEL_AUTOMATION_BYPASS_SECRET in your shell (see the header)}"
KEY="${LOAD_HOLD_KEY:-$HOME/.nightshift/load-hold/key.pem}"
[ -f "$KEY" ] || { echo "run-remote: no private key at $KEY"; exit 2; }
K6_VERSION=2.3.0
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

RUN="${1:-$(gh run list --workflow load-preview.yml --limit 1 --json databaseId --jq '.[0].databaseId')}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

echo "run-remote: waiting for the hand-off from run $RUN"
for _ in $(seq 1 60); do
  gh run download "$RUN" --pattern "load-hold-*" --dir "$WORK" >/dev/null 2>&1 && break
  sleep 20
done
CMS=$(find "$WORK" -name hold.cms | head -1)
[ -n "$CMS" ] || { echo "run-remote: no hand-off artifact (is the run in hold mode, and still holding?)"; exit 1; }
MSYS_NO_PATHCONV=1 openssl cms -decrypt -binary -inform DER -in "$(win "$CMS")" -inkey "$(win "$KEY")" -out "$(win "$WORK/hold.json")"
node -e 'const fs=require("fs"); const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); fs.writeFileSync(process.argv[2], JSON.stringify(h.seed)); fs.writeFileSync(process.argv[3], h.url);' "$WORK/hold.json" "$WORK/seed.json" "$WORK/url"
rm -f "$WORK/hold.json" "$CMS"
TARGET=$(cat "$WORK/url")
host=$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$TARGET")
case "$host" in
  nightshift-ten-iota.vercel.app|*nightshift.in) echo "run-remote: refusing, that is production"; exit 1 ;;
  nightshift-*-inrvishals-projects.vercel.app) ;;
  *) echo "run-remote: refusing, not a preview deployment URL"; exit 1 ;;
esac
echo "run-remote: target https://$host"

K6=$(command -v k6 || true)
if [ -z "$K6" ]; then
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) F="k6-v${K6_VERSION}-windows-amd64.zip" ;; Darwin) F="k6-v${K6_VERSION}-macos-arm64.zip" ;; *) F="k6-v${K6_VERSION}-linux-amd64.tar.gz" ;; esac
  BASE="https://github.com/grafana/k6/releases/download/v${K6_VERSION}"
  (cd "$WORK" && curl -sSfL -o "$F" "$BASE/$F" && curl -sSfL -o sums.txt "$BASE/k6-v${K6_VERSION}-checksums.txt" && grep " $F\$" sums.txt | sha256sum -c - >/dev/null && case "$F" in *.zip) unzip -q -o "$F" ;; *) tar -xzf "$F" ;; esac)
  K6=$(find "$WORK" -name 'k6' -type f -o -name 'k6.exe' -type f | head -1)
fi

echo "--- the network alone, this machine to the deployment"
TARGET="$TARGET" bash tools/load/network.sh
echo "--- k6: 200 virtual users for 3 minutes"
status=0
"$K6" run --quiet --summary-export "$(win "$WORK/summary.json")" -e BASE_URL="$TARGET" -e SEED_FILE="$(win "$WORK/seed.json")" -e SERVER_TIMING=1 tools/load/k6-load.js || status=$?
node tools/load/split.mjs "$WORK/summary.json"
node tools/load/quota.mjs "$WORK/summary.json"
cp "$WORK/summary.json" "k6-summary-remote-$RUN.json"
echo "run-remote: k6 exit $status (0 = every threshold passed); summary saved as k6-summary-remote-$RUN.json"
exit "$status"
