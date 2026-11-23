#!/usr/bin/env bash
# Prepares a LOCAL Postgres for the load test: a fresh database, migrated by
# the owner role, with app_runtime given a throwaway login password, then
# seeded. Prints nothing secret. Used by CI and for local runs.
#
#   ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres tools/load/prepare-db.sh 200 load-seed.json
#   then: the app's DATABASE_URL (as app_runtime) is in load.env
set -euo pipefail
VUS="${1:-200}"
OUT="${2:-load-seed.json}"
: "${ADMIN_URL:?ADMIN_URL (a local postgres:// owner URL) is required}"
case "$ADMIN_URL" in
  *@localhost:*|*@127.0.0.1:*) ;;
  *) echo "prepare-db: refusing a non-local database" >&2; exit 2 ;;
esac
DB="nsload_$(date +%s)"
export DB
PW="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
export PW
OWNER_URL="${ADMIN_URL%/*}/${DB}"
export OWNER_URL
node -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.ADMIN_URL });
  await c.connect();
  await c.query(`create database ${process.env.DB}`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });'
DATABASE_URL="$OWNER_URL" npx tsx scripts/migrate.ts
node -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.OWNER_URL });
  await c.connect();
  // Throwaway, local only (hex, so safe to inline). The role itself comes from migration 0008.
  await c.query(`alter role app_runtime with login password ${String.fromCharCode(39)}${process.env.PW}${String.fromCharCode(39)}`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });'
DATABASE_URL="$OWNER_URL" npx tsx scripts/load-seed.ts "$VUS" "$OUT"
RUNTIME_URL="$(node -e 'const u = new URL(process.env.OWNER_URL); u.username = "app_runtime"; u.password = process.env.PW; process.stdout.write(u.toString())')"
umask 077
# One throwaway key pair for every app process (as all Vercel instances share
# one): without it each process makes its own random keys, and a piece quoted
# through one process can't be decrypted when leased through another.
SIGNING_KEY="$(node -e 'process.stdout.write(require("crypto").generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"))')"
DATA_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
{
  printf 'DATABASE_URL=%s\n' "$RUNTIME_URL"
  printf 'COORDINATOR_SIGNING_KEY=%s\n' "$SIGNING_KEY"
  printf 'DATA_ENCRYPTION_KEY=%s\n' "$DATA_KEY"
} > load.env
echo "prepare-db: database ${DB} migrated and seeded; the app connects as app_runtime (see load.env)"
