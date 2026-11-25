# Moving NightShift's servers close to India

Our owners and buyers are in India. Today the app runs in Cleveland (Vercel
`cle1`), its database in Ohio (Neon `aws-us-east-2`) and its rate limiter on
Upstash (same US region family). From Hyderabad, every request crosses the
world and back before any of our code runs.

## Where to move

- **Database: Neon `aws-ap-southeast-1` (Singapore).** Neon has no Mumbai
  region (its regions page lists Singapore, Sydney and São Paulo for
  Asia-Pacific/South America). A Neon project's region is fixed when it's
  created, so this is a **new project**, not a branch.
- **Functions: Vercel `sin1` (Singapore), next to the database, not `bom1`.**
  One request makes 2-18 database round trips one after another (heartbeat 2,
  lease 9, quote 16, hand-in 18). From Mumbai to a Singapore database each one
  is ~55-65 ms, so `bom1` would add ~0.5-1 s to lease, quote and hand-in.
  With the functions in Singapore the round trips are ~1-5 ms each and the
  user pays the India-Singapore distance once (~35-70 ms each way). If Neon
  adds Mumbai later, move both to Mumbai together.
- **Rate limiter: a new Upstash database in `ap-southeast-1` for production,
  and a separate one for previews and load tests.** Sharing one between
  preview and production is how the free monthly quota (500,000 commands) was
  used up on 2026-11-24 (docs/INCIDENTS.md). If the replacements created that
  day are in a US region, these Singapore ones replace them; connect each to
  one environment only (CI refuses a shared one).

The three must move together: functions in Singapore talking to a database in
Ohio would be the worst of both.

## Steps (owner; about 30 minutes, a few minutes of downtime)

1. **Neon:** create a project in **AWS Asia Pacific (Singapore)**, the same
   Postgres major version as production or newer. Note its direct (not
   `-pooler`) owner connection string.
2. **Upstash:** create two Redis databases in `ap-southeast-1`:
   `nightshift-ratelimit-prod` and `nightshift-ratelimit-preview`.
3. **Pause writes:** a demo has no traffic to speak of; pick a quiet moment.
   Stop your own agents (`Ctrl+C`).
4. **Copy the data** (from your machine, Docker running; the URLs go in the
   environment, never in a file or chat):
   ```sh
   OLD_URL='…' NEW_URL='…' bash scripts/move-db.sh
   ```
   It refuses a non-empty target, runs the app's migrations on the new
   project (schema, `app_runtime`/`readonly` roles, grants, triggers), copies
   every row in one transaction, then compares every table's row count and
   content checksums, and marks the new project as production's database
   (`deployment_marker`, lib/isolation.ts). The old project is not touched.
5. **Switch over:**
   - Neon (new project, SQL editor): set the `app_runtime` and `readonly`
     passwords (SECURITY.md, "Database roles", step 2).
   - Vercel → Environment Variables → **Production**: `DATABASE_URL` (new
     project, pooled, user `app_runtime`), `DATABASE_URL_READONLY`
     (`readonly`), and the Upstash variables for `nightshift-ratelimit-prod`.
     **Preview**: the Upstash variables for `nightshift-ratelimit-preview`.
     Mark all of them **Sensitive**.
   - GitHub → Settings → Secrets: `NEON_PROJECT_ID` (new project; preview
     branches are then created in Singapore too) and, in the "production"
     environment, `PROD_DATABASE_URL_UNPOOLED` (new project, owner, direct).
   - Code: `vercel.json` `"regions": ["sin1"]` (a one-line change, merged
     only now, after the data is in Singapore).
6. **Deploy and check:** merge, let CI deploy production, then sign in, open
   the dashboards and run one agent piece. CI's production smoke test runs on
   its own.
7. **Keep the old project for 7 days**, untouched, as the backup. Then delete
   it in Neon.

## Rollback

Until step 7, set the three Vercel variables and two GitHub secrets back to
the old project, revert `vercel.json` to `cle1`, and redeploy. Anything written
to the new project after the switch would need copying back (the same script,
with OLD and NEW swapped, into a fresh empty project).
