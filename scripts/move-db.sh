#!/usr/bin/env bash
# Copies production's data into a new, empty Neon project (the region move:
# docs/REGION_MOVE.md). Run by the owner, from their own machine, with
# Docker running. Nothing is deleted from the old project.
#
#   OLD_URL='<old project, owner role, direct (not -pooler) URL>' \
#   NEW_URL='<new project, owner role, direct URL>' \
#   bash scripts/move-db.sh
#
# Steps: refuse unless both are Neon owner URLs and the new one is empty ->
# create the schema and roles on the new project with the app's migrations
# -> copy every table's rows (pg_dump --data-only, one transaction) -> compare
# row counts table by table. URLs are passed by environment, never printed.
set -euo pipefail
: "${OLD_URL:?OLD_URL (old project, owner, direct) is required}"
: "${NEW_URL:?NEW_URL (new project, owner, direct) is required}"
PG_IMAGE="postgres:18"

host() { node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$1"; }
OLD_HOST=$(host "$OLD_URL")
NEW_HOST=$(host "$NEW_URL")
# MOVE_DB_ALLOW_LOCAL=1: test-only, lets this run between two local databases.
if [ "${MOVE_DB_ALLOW_LOCAL:-}" != "1" ]; then
  for h in "$OLD_HOST" "$NEW_HOST"; do
    case "$h" in *-pooler.*) echo "move-db: use the direct URL, not the -pooler one (pg_dump needs a session)"; exit 2 ;; *.neon.tech) ;; *) echo "move-db: not a Neon host"; exit 2 ;; esac
  done
fi
[ "$OLD_URL" != "$NEW_URL" ] || { echo "move-db: OLD_URL and NEW_URL are the same database"; exit 2; }
echo "move-db: from ${OLD_HOST#*.} to ${NEW_HOST#*.}"

psqlc() { docker run --rm -i -e PGURL="$1" "$PG_IMAGE" sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -X -q -A -t'; }

# 1. The new project must be empty (no app tables yet, or no rows in them).
existing=$(echo "select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'job';" | psqlc "$NEW_URL")
if [ "$existing" != "0" ]; then
  rows=$(echo 'select (select count(*) from "user") + (select count(*) from job);' | psqlc "$NEW_URL")
  [ "$rows" = "0" ] || { echo "move-db: the new project already has data; refusing"; exit 2; }
fi

# 2. Schema, roles, grants and triggers: the same migrations production ran.
DATABASE_URL="$NEW_URL" npx tsx scripts/migrate.ts

# 3. Rows. Data only (the schema came from step 2), no owners or grants (the
#    migrations set them), not drizzle's own migration log (step 2 wrote it).
#    One transaction: it all lands, or nothing does.
#    The role guard trigger is switched off for the copy only, inside the same
#    transaction: copying a user row with its role is not a role change, and the
#    trigger would log it to audit_log, colliding with the audit rows being
#    copied. If anything fails, the transaction (trigger state included) rolls back.
{
  echo 'ALTER TABLE public."user" DISABLE TRIGGER user_role_guard;'
  docker run --rm -e OLD="$OLD_URL" "$PG_IMAGE" sh -c 'pg_dump "$OLD" --data-only --no-owner --no-privileges --exclude-schema=drizzle --quote-all-identifiers'
  echo 'ALTER TABLE public."user" ENABLE TRIGGER user_role_guard;'
} | docker run --rm -i -e NEW="$NEW_URL" "$PG_IMAGE" sh -c 'psql "$NEW" -v ON_ERROR_STOP=1 -X -q --single-transaction' >/dev/null
# The trigger is back on: check, rather than trust.
on=$(echo "select tgenabled from pg_trigger where tgname = 'user_role_guard';" | psqlc "$NEW_URL")
[ "$on" = "O" ] || { echo "move-db: user_role_guard is not enabled on the new project (state: $on); stop and check"; exit 1; }

# 4. Every public table, old count vs new count.
tables=$(echo "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1;" | psqlc "$OLD_URL")
bad=0
for t in $tables; do
  a=$(echo "select count(*) from public.\"$t\";" | psqlc "$OLD_URL")
  b=$(echo "select count(*) from public.\"$t\";" | psqlc "$NEW_URL")
  if [ "$a" = "$b" ]; then printf "  ok   %-22s %s rows\n" "$t" "$a"; else printf "  DIFF %-22s old %s, new %s\n" "$t" "$a" "$b"; bad=1; fi
done
[ "$bad" = "0" ] || { echo "move-db: row counts differ; production is unchanged, fix and rerun on a fresh new project"; exit 1; }

# 5. Content, not just counts: every stored blob (encrypted job data), every
#    money and credit row, and every piece's input and output hash.
sums="select md5(coalesce(string_agg(md5(data), '' order by key), '')) from public.blob;
select md5(coalesce(string_agg(id::text || ':' || amount_paise::text, ',' order by id), '')) from public.owner_ledger;
select md5(coalesce(string_agg(id::text || ':' || amount_paise::text, ',' order by id), '')) from public.buyer_ledger;
select md5(coalesce(string_agg(id::text || ':' || amount_gpu_seconds::text, ',' order by id), '')) from public.credit_ledger;
select md5(coalesce(string_agg(id::text || ':' || input_sha256 || ':' || coalesce(output_digest, ''), ',' order by id), '')) from public.fragment;"
a=$(echo "$sums" | psqlc "$OLD_URL")
b=$(echo "$sums" | psqlc "$NEW_URL")
[ "$a" = "$b" ] || { echo "move-db: content checksums differ (blobs, ledgers or pieces); production is unchanged, stop and check"; exit 1; }
echo "  ok   checksums of blobs, owner/buyer/credit ledgers and piece hashes match"
# 6. The new project is production's now: its marker names its own Neon
#    endpoint (the copy carried the old project's; lib/isolation.ts).
ep=$(node -e 'const h=new URL(process.argv[1]).hostname.split(".")[0]; process.stdout.write(/^ep-[a-z0-9-]+$/.test(h) ? h.replace(/-pooler$/, "") : "")' "$NEW_URL")
if [ -n "$ep" ]; then
  echo "insert into public.deployment_marker (name, value, updated_at) values ('production_endpoint', '$ep', now()) on conflict (name) do update set value = excluded.value, updated_at = now();" | psqlc "$NEW_URL" >/dev/null
  echo "  ok   the new project is marked as production's database (endpoint $ep)"
fi
echo "move-db: every table matches. Next: docs/REGION_MOVE.md step 5 (switch Vercel and GitHub to the new project)."
