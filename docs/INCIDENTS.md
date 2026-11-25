# Incidents

## 2026-11-24: preview load tests used up production's rate-limit quota

**Status:** mitigating. Production gets its own Upstash database (owner,
in progress); the fixes below are in PR #11, not merged yet.

### Cause

Preview and production shared one free Upstash Redis database: a single set
of `KV_*` variables in Vercel targeted both environments. The free plan
allows 500,000 commands a month for that database. Four preview load tests
(PR #11, 200 virtual users for 3 minutes each) used ~100,000-190,000
commands each and spent what was left of the month.

The estimate before the runs was ~38,000 a run, about 4x too low. It counted
rate-limit checks as if each were one command. Upstash bills the script call
plus every Redis command inside it, so a sliding-window check is 4-5 commands.
At the time each agent request also checked two limits (per IP and per PC).
CI's preview, E2E and ZAP runs on the same database had used part of the
month before that.

### Impact

- Once the quota ran out, every Upstash call failed. At the time a failed limit
  check was an unhandled error, so every route that checks a limit answered 500:
  - sign-in: the magic link and Google;
  - the waitlist;
  - every agent endpoint (heartbeat, lease, hand-in);
  - buyer quotes and confirms;
  - account and admin-code actions.
- Pages without limits kept working: the marketing pages, dashboards for
  people already signed in, and `/api/health`.
- **No data was lost.** Redis held only rate-limit counters.
- Load run 4 saw 57.7% 5xx on the preview from the same cause, so its timings
  were not used.

### Timeline (UTC)

| When (2026-11-23) | What |
|---|---|
| 20:05 | Load run 1 on the PR #11 preview (shared Upstash database) |
| 20:36, 20:47 | Load runs 2 and 3 |
| 20:56-21:01 | Load run 4: 57.7% 5xx; the Upstash quota is used up. Production starts failing on rate-limited routes at about the same time |
| 21:05 | Rate limits fall back to per-instance memory when Upstash fails (`7f4374a`, PR branch only). The `load-test` label was removed, so no more runs |
| shortly after | Owner told: create a new Upstash database for production, then a separate one for preview |
| next | Owner: new Production-only database, redeploy, production smoke test; then a Preview-only database |

### Fixes (PR #11)

1. **Each environment has its own Redis and database, and CI checks it.**
   - `scripts/check-env-isolation.mjs` runs before every preview deploy,
     production deploy and load test. It reads the Vercel variable list:
     names, environments and stores only, never values. It fails if a Redis
     or database variable targets both Preview and Production, or if both
     environments' copies come from the same store. On the setup above it
     refused all five `KV_*` variables.
   - Each Redis records which environment owns it (`ns:owner-env`, claimed
     by the first environment to use it). Production's database records its
     own Neon endpoint (`deployment_marker`, written by the production deploy).
     A preview that finds production's marker refuses to use that Redis or
     database. Production with the wrong one alerts, and `/api/health` returns
     503. This is in `lib/isolation.ts`.
   - Production deploys are staged: deployed without the domain
     (`--skip-domain`), then `/api/health` must pass on the new deployment,
     and only then is it promoted. A build pointed at preview's Redis or a
     preview branch never takes traffic.
2. **Load tests refuse unless the Redis is Preview-only and the run fits.**
   `tools/load/upstash-guard.mjs` runs before anything is created:
   - the Preview Redis's marker must say `preview`;
   - Upstash's API must report this month's use;
   - the estimated commands (`tools/load/upstash-budget.mjs`, ~117,000 for
     200 users for 3 minutes) must be at most 25% of what's left.

   Afterwards it prints Upstash's own count for the run. The per-IP agent
   limit, raised for load tests, is now counted per instance rather than in
   Upstash, which saves ~60,000 commands a run.
3. **Usage alerts at 70%.** `scripts/upstash-usage.mjs` runs:
   - after the preview and production smoke tests;
   - every 6 hours (`.github/workflows/quota-watch.yml`).

   It fails at 70% of any database's monthly allowance, and GitHub emails the
   owner. It needs the `UPSTASH_EMAIL` and `UPSTASH_API_KEY` secrets.
4. **Fail closed where per-instance limits are too weak.** When Upstash
   fails:
   - Sign-in, login emails, the waitlist and admin codes are refused (503, or
     a "briefly unavailable" message on the forms). Counting per instance
     would give an attacker one allowance per server instance.
   - Agent endpoints and buyer limits use each instance's own counter, so PCs
     keep working.
   - In both cases the owner gets an email straight away (`ops.alert` in the
     audit log; at most one per kind per 30 minutes), and the function logs
     show `[ops-alert]`.
   - A slow Redis now counts as a failure after 1.5 s. Before, the rate-limit
     library let requests through after 5 s, which would have failed open.

### Lessons

- An estimate of a metered resource has to use the provider's billing unit.
  Measure it on one run before running several.
- "Separate key prefixes" isolate data, not quota. Environments need separate
  databases, checked by a machine rather than by memory.
