# Security

Target: **OWASP ASVS 4.0 Level 2**, covering the **OWASP Top 10 (2021)**. This file maps each control to the code that implements it and the test that proves it. It grows every phase. Rows marked ⏳ are not built yet.

To report a vulnerability, email the team rather than opening a public issue.

## OWASP Top 10 mapping

| Risk | Control | Where | Proven by |
| --- | --- | --- | --- |
| A01 Broken access control | Server-side session check in every route handler, server action and protected page. Proxy is not trusted as an auth boundary | `lib/auth/guards.ts`, `lib/api/deps.ts`, `lib/api/handlers.ts` | `tests/integration/api-security.test.ts` (401 on every endpoint without a session) |
| A01 | Every query for user data is scoped to the session user's id. Another user's job, results, node, token or earnings answer 404, exactly like a missing one | `lib/coordinator/jobs.ts` (`ownJob`), `lib/coordinator/nodes.ts` (`ownNode`), `lib/ledger.ts` | `api-security.test.ts` (IDOR per resource) |
| A01 | Agents act only on their own leases: complete/fail checks node id, attempt number and lease expiry in one conditional UPDATE | `lib/coordinator/agent.ts` | `api-security.test.ts`, `coordinator.test.ts` (late result refused) |
| A01 / CSRF | Cookie-authenticated API writes require our own `Origin` (SameSite=Lax is the first lock) | `assertSameOrigin` in `lib/api/handlers.ts` | `api-security.test.ts` |
| A01 | Admin is two keys (database role **and** the `ADMIN_EMAILS` allowlist), read fresh on every request, plus a login from the last 15 minutes and a TOTP code. Checked in the `/admin` layout, the page, every admin server action and every admin API route; everyone else gets a 404. See [Admin](#admin) | `lib/admin.ts`, `lib/admin-access.ts`, `lib/auth/guards.ts`, `app/admin/*`, `lib/api/handlers.ts` (`requireAdminApi`) | `tests/integration/admin.test.ts`, `tests/e2e/dashboard.spec.ts`, `scripts/smoke.mjs` |
| A01 | Dashboards render from the same session-scoped functions as the API, and every button calls the JSON API, so each action gets the API's session, CSRF, rate-limit and ownership checks. Every dashboard page checks the session itself, not only the layout | `app/dashboard/data.ts` (`pageContext`), `components/dashboard/api.ts` | `tests/e2e/dashboard.spec.ts` (signed out → login page on every page; signed-in flows on the preview) |
| A01 | Framing blocked | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | `tests/unit/headers.test.ts`, `scripts/check-headers.mjs` |
| A02 Cryptographic failures | Node tokens: 256-bit random, stored as SHA-256 | `lib/security/tokens.ts`, `node_token.token_hash` | `tests/unit/tokens.test.ts`, `tests/integration/schema.test.ts` |
| A02 | Magic-link tokens stored hashed (Auth.js), single use, 15-minute expiry | `lib/auth/index.ts` | Manual: reused link → `/signin/error` |
| A02 | `upgrade-insecure-requests` on every page served over HTTPS (all deployed environments). Left off on plain-HTTP local servers, where WebKit would otherwise break every asset | `lib/security/headers.ts`, `proxy.ts` | `headers.test.ts` |
| A02 | HSTS (2 years, subdomains, preload) | `lib/security/headers.ts` | `headers.test.ts`, `check-headers.mjs` |
| A02 | Job data encrypted at rest: AES-256-GCM with a random key per piece, wrapped with `DATA_ENCRYPTION_KEY`. Associated data binds each ciphertext to its job and key, so blobs and wrapped keys can't be swapped between rows | `lib/security/envelope.ts`, `lib/coordinator/store.ts` | `tests/unit/crypto.test.ts`, `coordinator.test.ts` (no plaintext in the DB) |
| A02 | Separate signing and data keys per environment (Production, Preview, local). Required when deployed; dev/test use random per-process keys, never a key in the source | `lib/security/keys.ts`, `lib/env.ts` | `env.test.ts`, `crypto.test.ts` |
| A03 Injection | All SQL through Drizzle (parameterized). `sql.raw`, string-built SQL, plain-string `execute`, and `sql.identifier` with anything but a literal are banned. No endpoint takes SQL, a filter or a sort field from the user | `lib/db/client.ts`, `tools/semgrep/nightshift.yaml` | `semgrep --test tools/semgrep` (each rule has must-match and must-not-match examples), then the scan, in CI |
| A03 | Zod on every input boundary (strict objects: unknown keys refused), with size limits. Bodies are capped before and while reading (413). Validation errors name fields, never echo values | `lib/api/http.ts`, `lib/coordinator/*.ts` | `env.test.ts`, `workloads.test.ts`, `api-security.test.ts` |
| A03 / uploads | Images are typed by magic bytes only (PNG, JPEG, WebP). Name and Content-Type are ignored. SVG, GIF, HTML, PDF and executables are refused. Size and count caps per item and per job. Stored under random keys, never as files; results always download with `Content-Disposition: attachment` and `nosniff` | `lib/security/filetype.ts`, `lib/api/handlers.ts` | `workloads.test.ts`, `api-security.test.ts` |
| A03 / XSS | Strict CSP with per-request nonces and `strict-dynamic`. No `unsafe-inline`, no `unsafe-eval` in production. `dangerouslySetInnerHTML` and `eval` banned | `proxy.ts`, `lib/security/headers.ts`, `tools/semgrep/nightshift.yaml` | `headers.test.ts`, `check-headers.mjs`, Semgrep |
| A04 Insecure design | Ledgers and audit log are append-only: the app's database role has no UPDATE, DELETE or TRUNCATE on them, and a trigger stops every other role too. Balances are sums, never stored | `drizzle/0001_append_only.sql`, `drizzle/0008_phase8_security.sql` | `schema.test.ts` (refused as app_runtime and as the owner), `db-roles.test.ts` |
| A04 | Idempotency keys on every ledger row | `*_ledger.idempotency_key` unique | `schema.test.ts` |
| A04 | Agents never run buyer code. Three whitelisted workloads; buyers send data and enum/number parameters only, never scripts, model names outside the enum, or URLs. Agent output is validated against the workload's schema | `lib/coordinator/workloads.ts` | `workloads.test.ts`, `api-security.test.ts` |
| A04 | Digest-pinned container images per workload: the coordinator signs `image` into each task, and the agent refuses anything that isn't exactly the digest in its own whitelist. The two lists are kept identical by a test | `lib/coordinator/workloads.ts`, `agent/src/nightshift_agent/trust.py`, `.github/workflows/images.yml` | `tests/unit/agent-pins.test.ts`, `agent/tests/test_trust.py` (wrong digest, tag, other registry) |
| A04 / owners' PCs | Every fragment runs in a locked container built from an argument list (no shell): `--network none`, `--read-only`, noexec `/tmp` tmpfs, `--user 65534:65534`, `--cap-drop ALL`, `no-new-privileges`, Docker's default seccomp, pids/memory/CPU limits, `--stop-timeout`. `--gpus` only with an NVIDIA GPU and a workload that wants it. Input mounted read-only. Hard kill on timeout; container and temp files always removed | `agent/src/nightshift_agent/sandbox.py` | `agent/tests/test_sandbox.py` (exact argument list), `agent/tests/test_sandbox_docker.py` (real containers: no network, not root, no capabilities, no writes outside `/tmp` and `/out`, noexec `/tmp`, fork bomb stopped, memory hog killed, timeout kill and cleanup) |
| A04 / owners' PCs | Agent output is treated as untrusted: plain file names only (no paths, `..`, links, folders or reserved names), 4 MB cap, exact `{"items": [...]}` shape, sha256 sent with the upload and re-checked by the coordinator, then validated per workload | `sandbox.collect_output`, `lib/coordinator/agent.ts` | `test_sandbox.py`, `api-security.test.ts` |
| A04 / A08 | Results are checked, not trusted: about 1 piece in 10 of every job (at least one, picked at random when the buyer confirms) is re-run on a different PC and the outputs compared within a tolerance (embeddings by cosine similarity and length, captions by word overlap, resized images by type, size and dimensions). A disagreement goes to a third PC. The PC on the losing side loses trust, and if its output was the wrong one, its compute pay for the piece is reversed and the buyer's piece is replaced with the agreed result. A PC below trust 200 is quarantined: its agent is refused, its work requeued, and only an admin can release it | `lib/coordinator/verify.ts`, `lib/coordinator/verification.ts`, `lib/coordinator/agent.ts` | `tests/unit/verify.test.ts`, `tests/integration/verification.test.ts` (match, corrected piece, blamed checker, inconclusive, quarantine, admin-only release), `tests/live/agent-preview.ts` (a second real agent checks the first) |
| A04 / A08 | Coordinator challenges (canaries): signed text-embedding pieces made of random sentences with a hidden structure that only a real run of the model produces (exact duplicates and UPPERCASE copies give the same vector; a sentence is closer to itself plus two words than to an unrelated one). Sent on a PC's first lease, then about 1 lease in 20, at most hourly, and indistinguishable from real work in the task. A made-up answer is caught on hand-in: trust −250, no pay, audited | `lib/coordinator/challenge.ts`, `challenge-db.ts` | `tests/unit/challenge.test.ts` (random, constant, hashed and unnormalised answers fail; an honest embedder passes), `tests/integration/attacks.test.ts`, `tests/live/agent-preview.ts` (both real agents pass). Checked against the real pinned model: 3 of 3 challenges passed with large margins |
| A04 | Speed scores are the coordinator's, not the PC's: each passed challenge is timed lease-to-result on the coordinator's clock (a PC can only make itself look slower), the score is the median of the last 5 runs with runs more than 2× off the median dropped, and needs 3 runs. The agent's self-reported benchmark is stored for display and used nowhere | `challenge.ts` (`medianScore`), `agent.ts` (`heartbeat`) | `challenge.test.ts`, `attacks.test.ts` (claims 10 000, scores 500) |
| A04 | One lease per PC at a time (no hoarding), and a lease that runs out costs 25 trust, so a PC that keeps grabbing work it doesn't do ends up quarantined | `agent.ts` (`leaseFragment`), `tick.ts` | `attacks.test.ts` |
| A04 / A08 | Replayed results: output whose digest already belongs to a different piece is refused (422) and counts as a failed check; the same hand-in twice is refused (409) and paid once | `agent.ts` (`completeFragment`) | `attacks.test.ts` |
| A04 | Power reports are clamped to a per-class ceiling and audited, so electricity pay can't be inflated; the quote's price cap still bounds what any PC is paid | `classes.ts` (`clampWatts`), `agent.ts` | `attacks.test.ts` |
| A04 | Fake-node farms: 20 PCs per account; a check isn't given to a PC of the same owner for 30 minutes if another owner's PC can take it, and a same-owner match earns no trust | `agent.ts`, `verification.ts` | `attacks.test.ts` |
| A04 | Held earnings: pay for a piece waits while its check is open, and everything a quarantined PC earned is held. (Payouts are simulated; "held" means the payout run skips it) | `verification.ts` (`heldEarnings`), `/api/earnings` | `attacks.test.ts` |
| A04 / A08 | Known-answer canaries: re-runs of real pieces two other owners agreed on, sent as ordinary checks; a wrong answer goes through a tie-break before blame. A classifier trained on everything the agent sees can't tell them from real work (held-out accuracy at chance) | `lib/coordinator/canary.ts` | `tests/integration/canary.test.ts` |
| A04 | Adaptive checking: 50% of a new PC's first 20 pieces, then 50% → 10% as trust rises, back to 50% at low trust | `lib/coordinator/verify.ts` (`checkRate`), `verification.ts` | `tests/unit/check-rate.test.ts`, `attacks.test.ts` |
| A04 / A07 | Sybil limits: one payout UPI ID per account (keyed hash, unique index); shared device or network across accounts flagged; checks never go to a PC on the same account, device or network as the work; preview-only "report" mode refused in production by env validation | `lib/coordinator/sybil.ts`, `lib/env.ts` | `tests/unit/sybil.test.ts`, `attacks.test.ts`, `tests/live/agent-preview.ts` |
| A04 | Time-Bank credits: append-only ledger, idempotent keys, pending until verified, clawed back for wrong/unverifiable work and on quarantine, expire after 6 months, spent oldest-first under a row lock (no double spend), never converted to money (no entry type, function or route) | `lib/credits.ts` | `tests/integration/timebank.test.ts` |
| A04 | Every job costs at least ₹10; the top-up goes on the fee line and is shown | `lib/pricing.ts` | `tests/unit/pricing.test.ts` |
| A04 | Money can't be created by racing or retrying: every state change is a conditional UPDATE, every ledger row has a unique idempotency key, a refund is booked at most once | `lib/coordinator/lifecycle.ts`, `lib/ledger.ts` | `coordinator.test.ts` (one refund row, paid once) |
| A04 | What owners are paid can never exceed what the buyer was quoted: quotes are priced per piece at the costliest available PC, and a PC that costs more can't take the job | `lib/coordinator/schedule.ts` (`withinCap`), `jobs.ts` | `scheduler.test.ts` (property test), `coordinator.test.ts` |
| A05 Security misconfiguration | Env validated with Zod at boot. Dev-only backends refused when deployed | `lib/env.ts`, `instrumentation.ts` | `env.test.ts` |
| A05 | Full header set: CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP. `X-Powered-By` removed | `lib/security/headers.ts`, `next.config.ts` | `headers.test.ts`, `check-headers.mjs` (preview and production) |
| A05 | Generic error pages. Details never reach the browser | `app/error.tsx`, `app/signin/error`, `lib/auth/email.ts` | `tests/unit/email.test.ts` (provider body not leaked) |
| A06 Vulnerable components | Lockfile committed, exact versions pinned, Dependabot (npm, pip, actions), `npm audit --audit-level=high`, OSV scanner, `pip-audit`. Actions pinned to commit SHAs | `.github/` | CI job 4 |
| A07 Auth failures | No passwords. Email magic link everywhere, plus Google (verified emails only) on origins whose redirect URI is registered | `lib/auth/index.ts`, `lib/auth/google.ts` | `tests/unit/google.test.ts`; Playwright ⏳ phase 5 |
| A07 | "Log out of all devices" deletes every session for the account and is audited (`auth.logout_all`) | `lib/auth/sessions.ts`, `app/dashboard/actions.ts` | `tests/integration/sessions.test.ts` |
| A07 | Database sessions. httpOnly, SameSite=Lax cookies, Secure with the `__Secure-` prefix when deployed. New session on every login, and the browser's previous session is revoked | `lib/auth/index.ts` (`revokeIncomingSession`) | Manual, verified on a local prod build; Playwright ⏳ |
| A07 | Rate limits: login per IP (10/15 min) and per email (3/15 min), quotes (30/min), job confirm/cancel (10/min), node management (20/hour), account export and delete (5/hour), agents per IP (600/min, checked before any token lookup) and per node (240/min). 429 with `Retry-After` | `lib/ratelimit.ts`, `app/api/auth/[...nextauth]/route.ts`, `lib/api/handlers.ts` | `tests/unit/ratelimit.test.ts`, `api-security.test.ts` (every surface) |
| A07 | Node tokens: shown once at registration or rotation, stored only as SHA-256, revocable from the dashboard API. Revoking locks the agent out on its next request and frees its work | `lib/coordinator/nodes.ts`, `lib/coordinator/agent.ts` | `api-security.test.ts`, `coordinator.test.ts` |
| A07 | CSRF: Auth.js double-submit token on its endpoints; Next.js Server Actions check the Origin header | Auth.js, Next.js defaults (left on) | Manual: POST without token → `MissingCSRF` |
| A04 / A07 | Waitlist: Zod validation (email ≤ 254 chars, fixed interest values, consent required), 5 signups per IP per hour, and the same reply for new and existing emails (no way to check who signed up) | `lib/waitlist.ts`, `app/(marketing)/waitlist/actions.ts` | `tests/integration/waitlist.test.ts`; `tests/e2e/site.spec.ts` (repeat signup, rate limit) |
| A03 | Invoice PDFs come from a small in-house writer (no PDF library): text is reduced to printable ASCII and `\ ( )` are escaped, so account or job text can't break out of a PDF text operator. Served as an attachment with `nosniff` | `lib/pdf.ts`, `lib/invoice.ts` | `tests/unit/pdf.test.ts` (escaping, xref offsets), `dashboard.test.ts` (IDOR 404, 401, 409 before confirm) |
| A03 / XSS | Server HTML has no inline `style` attributes (a nonce doesn't cover them), and pages load with zero console or CSP errors | components use Tailwind classes only | `tests/e2e/site.spec.ts` |
| A08 Integrity failures | Coordinator signs every task with Ed25519 over the exact JSON bytes it sends: node id, attempt, workload, parameters, input sha256, expiry (= lease end), 128-bit nonce. Public key at `/api/agent/signing-key` | `lib/security/signing.ts`, `lib/coordinator/agent.ts` | `crypto.test.ts` (tampered, wrong key, expired, wrong node, replayed nonce), `coordinator.test.ts` (every task verifies), `tests/e2e/api.spec.ts` |
| A08 | Agent verifies before running anything: Ed25519 signature against keys pinned in the agent (the key id is recomputed from the pinned key, never trusted from the task), version, expiry, issue time, node id, a persistent nonce store (replays refused even after a restart), workload whitelist, exact image digest, input sha256 | `agent/src/nightshift_agent/trust.py`, `nonces.py` | `agent/tests/test_trust.py` (every rejection reason) |
| A08 | Agent updates only from signed releases: Ed25519 over a manifest holding the wheel's sha256, verified against a pinned release key before `pipx install` | `agent/src/nightshift_agent/updates.py` | `agent/tests/test_parts.py` (bad signature, tampered manifest, swapped wheel). The release key isn't created yet, so every update is refused (see below) |
| A08 / supply chain | Agent and workload images install only hash-pinned packages (`--require-hashes`), at least two weeks old when locked; base image and model weights pinned by digest and revision | `agent/requirements*.lock`, `agent/workloads/*/requirements.txt`, Dockerfiles | pip-audit in CI on both agent lockfiles |
| A08 | Agent outputs carry a sha256 that must match the body | `completeFragment` | `api-security.test.ts` |
| A08 | gitleaks pre-commit hook and CI full-history scan | `.githooks/pre-commit`, `.gitleaks.toml` | CI job 4 |
| A09 Logging failures | Audit log: logins, logouts, rate-limit hits, node registration and settings changes, token creation and revocation, job confirmation, refunds quarantines (`node.quarantined`), releases (`node.released`, by the admin's id), corrected pieces (`job.piece_corrected`) (later: payouts). IPs stored only as an HMAC | `lib/audit.ts` | `schema.test.ts` (IP never stored), `api-security.test.ts` (token events audited) |
| A09 | Sentry with PII scrubbing | – | ⏳ phase 8 |
| A10 SSRF | No server-side fetching of user-supplied URLs. Job inputs are uploaded data, never URLs; workload parameters reject unknown keys such as `url`. The only outbound call is to a fixed Resend URL | `lib/auth/email.ts`, `lib/coordinator/workloads.ts` | `workloads.test.ts`; code review; Semgrep |

## Admin

Admin can't be gained through the app, and `/admin` is nothing to anyone else.

- **Two keys.** An account is an admin only if `user.role = 'admin'` in the database **and** its email is on `ADMIN_EMAILS` (a server-only env var). Either one alone does nothing. Both are read from the database and the environment on every request (`lib/admin.ts`, `isAdmin`), never from the session, a cookie or a header: the session carries the user id only.
- **Nothing in the app writes `role`.** No route, server action or form takes it (every input schema is strict, so `role`, `isAdmin`, `trust` or `ownerId` in a body is a 400), Semgrep bans `role`/`isAdmin` in any `.set()`/`.values()`, and a test scans the source for it.
- **The database stops it too** (migration 0008). The app's role `app_runtime` has no UPDATE privilege on `user.role`. A trigger (`user_role_guard`) undoes a change to `role` by any role that isn't the table owner (or a member of it), on INSERT and UPDATE, and writes every attempt, allowed or refused, to the audit log (`admin.role_changed`, `admin.role_change_refused`). The refusal undoes the change instead of raising an error, so that the audit row isn't rolled back with it. The scheduler emails every role change and every refused attempt to the admins (`lib/alerts.ts`).
- **Stronger sign-in for admin.** Admin pages and actions need a login from the last 15 minutes (`session.created_at`) **and** a code from an authenticator app (TOTP, RFC 6238) entered on that session (`session.mfa_at`). The first time, the admin sets one up on `/admin` (the secret is sealed with `DATA_ENCRYPTION_KEY`); once confirmed, the app can't switch it off or replace it (no privilege, plus a trigger), and setting it up emails the admins. A code works once. Five tries per 15 minutes. Sessions that existed before migration 0008 count as old logins.
- **Checked everywhere, trusted nowhere.** The `/admin` layout, the page, every admin server action (`app/admin/actions.ts`) and every admin API route (`requireAdminApi`) check for themselves. `proxy.ts` plays no part; no header is trusted (`x-middleware-subrequest`, made-up role headers: Semgrep bans reading them). Non-admins get the same 404 as a page that doesn't exist, for every method on the admin API too. An admin without the step-up gets a 403 asking for it.
- **Audited.** Every admin page view (`admin.viewed`), authenticator setup, code and failed code, and every action (`node.released`, actor type `admin`).
- **Reads as `readonly`.** The admin panel's reports use the `readonly` database role when `DATABASE_URL_READONLY` is set: no emails, sessions, tokens or job data.

**Making someone an admin** (owner only, in the Neon SQL editor, as the owner role): `update "user" set role = 'admin' where email = '<their email>';`, then add the email to `ADMIN_EMAILS` in Vercel and redeploy. They set up their authenticator on their first visit to `/admin`. **Resetting an authenticator:** `delete from admin_totp where user_id = '<id>';` (owner role only), then log that account out of all devices.

## Database roles

| Role | Used by | Can | Can't |
| --- | --- | --- | --- |
| `app_runtime` | the web app (Vercel `DATABASE_URL`) | SELECT/INSERT on the tables it needs; UPDATE on named columns only; DELETE only on sessions, logins, used email links and job data | change the schema, create temp tables or functions, UPDATE/DELETE/TRUNCATE ledgers or the audit log, UPDATE `role`, `owner_id` or `buyer_id`, delete accounts, read the migration history, grant anything |
| `readonly` | admin reports (`DATABASE_URL_READONLY`) | SELECT on PCs, jobs, the three ledgers, the audit log, canary covers, and `user` (id, role, dates) | read emails, sessions, tokens, job data or TOTP secrets; write anything |
| migrator: the schema owner (Neon: `neondb_owner`) | the deploy step only (`PROD_DATABASE_URL_UNPOOLED`, GitHub "production" environment) | migrations; setting roles | — |

The exact privileges are tested table by table and column by column (`tests/integration/db-roles.test.ts`): a new table without a decision there fails CI. The whole integration suite runs as `app_runtime`, which proves the grants are enough. Every preview deployment runs as `app_runtime` with admin reports as `readonly`, on a copy of production (`scripts/preview-db-roles.mjs`, `tests/live/db-exposure.ts`).

The migrator is Neon's owner role rather than a third, new role: tables are owned by `neondb_owner`, and handing them to a new role isn't something a migration can do safely on Neon. What matters is where its password lives: only in GitHub's "production" environment, used by the migrate step. Once production uses `app_runtime`, Vercel never has it.

**TLS.** Deployed environments refuse a database URL without a verified TLS connection (`lib/env.ts`): Neon hosts are reached over `wss://` (Node checks the certificate), any other host needs `sslmode=verify-full`. The preview check also proves Neon refuses a plain connection.

**No other way in.** No endpoint runs user-supplied SQL or filters. The preview check fails if the Neon Data API (PostgREST roles), GraphQL (`pg_graphql`) or outbound extensions (dblink, http, postgres_fdw) exist on the database.

**Switching production to `app_runtime`** (one time, after this phase's migration has run in production):
1. Make a password: `openssl rand -hex 24`.
2. In the Neon SQL editor (production branch, owner role): `alter role app_runtime with login password '<password>';` and the same for `readonly` with a second password.
3. In Vercel → Settings → Environment Variables (Production): set `DATABASE_URL` to the pooled connection string with user `app_runtime` and that password (copy the owner's pooled string and swap the user and password), and `DATABASE_URL_READONLY` the same way for `readonly`. Mark both **Sensitive**. Redeploy.
4. Check: `/api/health` says ok, and in Neon `select distinct usename from pg_stat_activity;` shows `app_runtime`.

**Rotating a database password** (any role, any time, no downtime for `app_runtime`/`readonly`): set a new one with `alter role <role> with password '<new>';`, update the env var in Vercel (or the GitHub secret for the owner), redeploy. Old connections end when their pool closes them. For the owner role, use Neon's "Reset password" and update `PROD_DATABASE_URL_UNPOOLED` in GitHub.

## Environment variables

Nothing below is ever `NEXT_PUBLIC_`: env validation refuses secret-looking public names (`lib/env.ts`), Semgrep bans them, and CI scans every file a browser can download for secret values and patterns (`scripts/scan-bundle.mjs`).

| Variable | Where it's used | Server only | Secret | How to rotate |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | app's database connection (as `app_runtime`) | yes | yes | see "Rotating a database password" |
| `DATABASE_URL_READONLY` | admin reports (as `readonly`), optional | yes | yes | same |
| `DATABASE_URL_UNPOOLED` | migrations (`scripts/migrate.ts`), local only | yes | yes | same |
| `AUTH_SECRET` | Auth.js, and the key for IP and device hashes | yes | yes | new random 32+ chars in Vercel, redeploy. Logs everyone out (their sessions are DB rows, still valid; audit IP hashes change) |
| `AUTH_URL` | Auth.js base URL, optional | yes | no | — |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google login | yes | secret: yes | Google Cloud Console → new client secret → Vercel → redeploy → delete the old one |
| `AUTH_GOOGLE_REDIRECT_ORIGINS` | where Google login is offered | yes | no | — |
| `EMAIL_TRANSPORT`, `EMAIL_FROM` | magic links and alerts | yes | no | — |
| `AUTH_RESEND_KEY` | Resend (magic links, security alerts) | yes | yes | Resend → new API key → Vercel → redeploy → revoke the old one |
| `RATE_LIMIT_BACKEND` | rate limiter | yes | no | — |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN`, or `KV_REST_API_URL` / `KV_REST_API_TOKEN` | rate limits (Upstash via the Vercel integration) | yes | token: yes | Upstash → reset the token → it syncs to Vercel → redeploy |
| `KV_URL`, `REDIS_URL`, `KV_REST_API_READ_ONLY_TOKEN` | set by the Upstash integration, not used by the app | yes | yes | as above |
| `CRON_SECRET` | `/api/cron/tick` | yes | yes | new random 32+ chars in Vercel (Vercel Cron reads it), redeploy |
| `COORDINATOR_SIGNING_KEY` | signs agent tasks (Ed25519) | yes | yes | new key, Vercel, redeploy; agents pick up the new public key from `/api/agent/signing-key` (the kid changes) |
| `DATA_ENCRYPTION_KEY` | wraps per-piece job keys; seals TOTP secrets | yes | yes | not rotated in place yet: changing it makes stored job data (≤ 7 days) and admin authenticators unreadable. Rotate after a quiet week, then reset admin authenticators |
| `ADMIN_EMAILS` | second admin key | yes | personal data | edit in Vercel, redeploy |
| `ADMIN_ALERT_EMAIL` | where security alerts go (default: `ADMIN_EMAILS`; previews: none) | yes | personal data | — |
| `PREVIEW_EMAIL_ALLOWLIST` | previews only: the only addresses magic links go to (empty: previews send no login mail, so scanners can't make them send any) | yes | personal data | — |
| `NODE_TLS_REJECT_UNAUTHORIZED` | never set it; `0` (certificate checks off) is refused in preview and production | — | no | — |
| `AGENT_IP_LIMIT_PER_MIN` | preview load test only: raises the per-IP agent limit (200 virtual PCs share one runner IP); set only on the load-test deployment; refused in production | yes | no | — |
| `SYBIL_CHECKER_RULES` | `enforce` (production must) or `report` (previews) | yes | no | — |
| `CONTACT_EMAIL`, `SITE_URL`, `DEMO_MODE`, `APP_ENV` | privacy page, metadata, demo banner, environment | yes | no | — |
| `SENTRY_DSN` | reserved; the Sentry SDK isn't installed yet | yes | no | — |

**CI and deploy secrets** (GitHub Actions; masked in logs by GitHub, and the preview's generated database passwords are masked with `::add-mask::`):

| Secret | Used by | How to rotate |
| --- | --- | --- |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | preview and production deploys | Vercel → Account → Tokens → new token → GitHub secret → delete the old one |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | E2E, ZAP and Lighthouse on protected previews | Vercel → Deployment Protection → regenerate → GitHub secret |
| `NEON_API_KEY`, `NEON_PROJECT_ID` | creating and deleting preview branches | Neon → Account → API keys → new key → GitHub secret → revoke the old one |
| `PROD_DATABASE_URL_UNPOOLED` ("production" environment) | the migrate step only | Neon → reset the owner password → update the secret |
| `PROD_BASE_URL` ("production" environment) | production smoke test and Lighthouse | — |

## Secrets in CI (GitHub Actions)

- No `pull_request_target` and no `workflow_run`: a fork's code never runs with this repo's secrets. Jobs that need secrets (preview and everything after it, preview cleanup) skip fork PRs.
- Every job states its own permissions; the workflow default is none. Only the image build can write packages; only CodeQL can write security events.
- Checkouts don't keep the GitHub token (`persist-credentials: false`). Every action is pinned by commit SHA; every downloaded tool (gitleaks, Trivy, k6) is checked against its release checksums.
- Workflow expressions are passed to scripts through `env:`, never written into the script. `zizmor` audits the workflows on every run.

## Lockdown checks (Phase 8)

| Check | How | Proven by |
| --- | --- | --- |
| A1 No input can set `role`, `isAdmin`, `trust` or `ownerId` | strict schemas everywhere; no role writes in code | `mass-assignment.test.ts` (every JSON endpoint, with `__proto__` too; bodiless routes ignore bodies; source scan), Semgrep `no-role-writes` |
| A2 The database blocks role changes | no column privilege + `user_role_guard` trigger; every attempt audited and emailed | `admin.test.ts` ("A2"), `db-roles.test.ts` |
| A3 Two-key admin | `isAdmin` needs role and `ADMIN_EMAILS` | `admin.test.ts` ("A3 + A4"), `env.test.ts` |
| A4 Role read fresh from the database | no role in the session or its types | `admin.test.ts` (role removed → next request is a 404) |
| A5 Fresh login + TOTP for admin, audited, alerts | `lib/admin-access.ts`, `lib/security/totp.ts`, `lib/alerts.ts` | `totp.test.ts` (RFC 6238 vectors), `admin.test.ts` ("A5"), `dashboard.spec.ts` (admin sets up an authenticator in a real browser) |
| B `/admin` gives non-admins nothing | layout + page + action + API checks, 404 | `admin.test.ts` ("B"), `dashboard.spec.ts` (buyer and owner: pages, every admin API method, admin server actions called by ID, spoofed headers), `smoke.mjs` (anonymous, spoofed headers, every method) |
| C No SQL from users; Semgrep bans raw/string SQL | `tools/semgrep/nightshift.yaml` | `semgrep --test tools/semgrep`, then the scan |
| C No Data API / GraphQL / REST into the database | preview check on a copy of production | `tests/live/db-exposure.ts` |
| C Three roles, least privilege | migration 0008 | `db-roles.test.ts`; whole integration suite as `app_runtime`; previews run as `app_runtime` (live test checks `pg_stat_activity`) |
| C TLS with certificate verification | env validation; `wss://`; `verify-full` | `env.test.ts`, `db-exposure.ts` (TLS connection; plain refused) |
| C IDOR on every resource | session-scoped queries | `api-security.test.ts` (jobs, results, invoices, PCs, tokens, earnings, Time-Bank, export, UPI, credits, agent leases) |
| D1 No secrets in the browser bundle | `scripts/scan-bundle.mjs` (env values, patterns, server-only names, maps) | `scan-bundle.test.ts`; CI on the build, the preview (with `vercel pull` values) and production |
| D2 No public source maps | `productionBrowserSourceMaps: false` | `scan-bundle.mjs`, `smoke.mjs` (every script's `.map` is a 404) |
| D3 Error pages and health reveal nothing | generic error page; `{"status":"ok"}` only | `smoke.mjs` (no env names, versions or stack traces) |
| D4 No exposed files | nothing outside `public/` is served | `smoke.mjs` (`/.env`, `/.env.local`, `/.git/config`, `/next.config.js`, `/package.json` and more → 404), on the build, every preview and production |
| D5 GitHub Actions | see "Secrets in CI" | `zizmor` in CI |
| D6 Every env var documented | this section | review |

## Data protection (India DPDP Act)

- **Minimisation**: we never store a name, profile picture or OAuth tokens (`lib/auth/adapter.ts`, proven in `schema.test.ts`). Google is asked for `openid email` only. IPs are stored only as a keyed hash.
- **Data export** (Account → Download my data): one JSON file with the account, PCs, jobs, all three ledgers and the user's own activity log, without idempotency keys, IP hashes or token hashes. Audited (`account.exported`). `lib/account.ts`, proven in `tests/integration/account.test.ts`.
- **Account deletion** (Account → Delete my account, type DELETE): removes the email and every login (sessions, Google link, pending email links), revokes every PC token (agents are locked out and their work is requeued), and deletes all stored job data at once instead of after 7 days. Refused while a job is still running. Users are never hard-deleted because ledger rows reference them: the ledgers keep their rows under the random account id, with no email left to link it to a person. Deleted accounts can't log in again; the same email would make a new, empty account. Audited (`account.deleted`). Proven in `account.test.ts`.
- **Retention**: job inputs and outputs are deleted 7 days after a job ends (`job.purge_after`), an unconfirmed quote's data when the quote expires or is cancelled. Ledger rows stay (they hold no job data). Proven in `coordinator.test.ts`.

## What this does NOT protect against (so far)

- **Checks are sampled.** Only about 1 piece in 10 is re-run, so a PC that cheats once can get away with it; one that cheats often loses trust fast (two failed checks take a new PC into quarantine).
- **Fake accounts are flagged, not stopped.** We don't verify identity. One UPI ID per account is enforced, and shared devices and networks are flagged and kept from checking each other, but a person with several phones, SIMs and UPI IDs can still run several accounts. Device IDs come from the agent, which anyone can modify, so they can be faked; networks are shared by hostels and mobile carriers, so they can't be a hard rule for anything but checks.
- **Small networks are checked by canaries only.** A check never goes to a PC on the same account, device or network, so in a college lab or a one-person demo no independent check can run. Those pieces go canary-only: their pay is held until the PC passes a canary issued after them (30% of its leases are canaries meanwhile), with no trust gain. That proves the PC was honest on the canary, not on each piece: a PC that cheats only on real pieces and answers canaries honestly is caught only if it can't tell them apart. Where no verified real piece exists yet (a brand-new lab), the canaries are the made-up challenges, which can be recognised (see below).
- **The made-up fallback challenges can be recognised** by someone who reads this code (the templates are public), and in a network of small jobs their size (250 sentences) stands out: the classifier test spots them every time. They're only sent while no verified real piece is available; after that, canaries are re-runs of real pieces, which the same classifier can't tell apart from real work.
- **Known-answer canaries send a buyer's piece to one more PC**, only while the job's data exists (7 days). The privacy page says so.
- **The speed scale is anchored on an estimate** (`REFERENCE_CHALLENGE_ITEMS_PER_SEC`), not a measured RTX 3060. Scores compare PCs fairly with each other; the absolute number isn't calibrated yet (docs/CALIBRATION.md). Speed is used for planning and matching only; Time-Bank weighting is frozen at 1.0×.
- **Credits count work, not time** (since Phase 8): a piece earns what the reference RTX 3060 would take for it, and a job costs the same unit, so the slow-earn, fast-spend gap is closed. What's left: the per-item costs are estimates until calibrated on a real RTX 3060 (docs/CALIBRATION.md), so one workload may be slightly over- or under-valued against another.
- **Resized images are compared by type, dimensions and file size, not pixels.** The coordinator doesn't decode images. A PC that returns a blank image of the right size and roughly the right file size would pass.
- **Checks happen after the job finishes**, so a buyer may already have downloaded a piece that is later corrected. The job page says so and the corrected result is downloadable.

- **A node sees the plaintext of the fragment it computes.** Encryption at rest protects stored data, not data while a GPU works on it. Splitting jobs into fragments limits how much of a job any one node sees. It does not hide that fragment. Don't send data you can't let a stranger's PC see.
- **The in-memory rate limiter** (dev only) is per process. Deployed environments must use Upstash, and env validation enforces it.
- **Client IP for rate limits** comes from `x-real-ip` / `x-forwarded-for`. On Vercel these are set by the platform. Anywhere else, a client can spoof them.
- **Sessions on other devices** stay valid after a new login, until they expire (7 days). "Log out of all devices" on the dashboard ends them all at once.
- **Account takeover is the realistic way in.** An attacker with the admin's email inbox can log in by magic link, and the first time also set up the authenticator (the setup emails the admins). Turn on 2FA on the email account and on GitHub, Vercel, Neon, Google, Resend and Upstash: whoever controls those controls the app. Passkeys aren't offered yet; TOTP is.
- **Production runs as the owner database role until it's switched** (see "Switching production to app_runtime"): the roles, grants and triggers are in production from this phase's migration, but `DATABASE_URL` in Vercel is the owner's until the owner sets the new login. The role trigger protects `role` either way.
- **No Sentry yet.** The SDK isn't installed, so there are no source maps to upload: none are built for the browser at all.
- **Google login is not available on Vercel preview URLs.** Google needs every redirect URI registered exactly, with no wildcards, and each preview gets a new URL. Google is offered only on origins listed in `AUTH_GOOGLE_REDIRECT_ORIGINS` (localhost and production), and previews use the email link. This is expected, not a bug. Don't set Google credentials in the Vercel Preview environment.
- **Auth.js v5 is still beta** (`next-auth@5.0.0-beta.32`, pinned exactly). It's the only Auth.js line for the App Router. Dependabot will offer upgrades, and each one has to pass the auth tests.
- **Magic links on previews need Resend with a verified domain.** Without one, Resend only delivers to the account owner's own address.
- **The agent's release key isn't created yet.** It has to be generated and stored as a GitHub Actions secret, which needs the owner's go-ahead. Until then the agent refuses every update, and installs come from the repo.
- **GPU work runs on CPU builds for now.** The workload images use CPU PyTorch, so `--gpus` is wired and tested but brings no speed-up yet. CUDA images are a follow-up.
- **On Windows, the output folder can't be made unlistable.** Docker Desktop bind mounts ignore Linux file modes. Every other sandbox flag applies.
- **A container still sees the plaintext of its own fragment** (see the first point at the top of this list).
- **The benchmark's RTX 3060 reference time is an estimate** until it's measured on a real RTX 3060. Scores are relative to it.
- **The scheduler runs on traffic.** Vercel Hobby cron runs once a day, so the tick also runs (throttled to once per 15 s) whenever an agent asks for work or a buyer looks at a job. With no traffic at all, a missed deadline is refunded at the next request or the daily cron.
- **Job data lives in Postgres** (encrypted), not object storage, to keep the prototype on free tiers. Size caps (4 MB per request, 3 MB per job) keep it small.
- **Semgrep suppressions** (each is one rule on one line, with the reason beside it). List any new suppression here.
  - `scripts/check-copy.ts`, `react-insecure-request`: the copy checker fetches pages over plain HTTP from the `next start` server it spawns on `127.0.0.1`.
  - `scripts/demo-lifecycle.ts` (the `local()` helper), `react-insecure-request`: the lifecycle demo talks to the `next start` server it spawns on `127.0.0.1`, and the helper refuses any other origin.
  Both are loopback to a local build, not network requests.
  - `agent/workloads/image_captioning/convert_weights.py`, `pickles-in-pytorch`: the pinned BLIP revision (official repo, fixed commit) ships only pickle weights. The image build loads them once with `torch.load(weights_only=True)` (tensors only, no code), saves safetensors and deletes the pickle. This runs in CI at build time only; owners' PCs never load a pickle.
- **Pinned override**: `drizzle-kit` depends on the deprecated `@esbuild-kit/core-utils`, which asked for an old `esbuild` with a known advisory (GHSA-67mh-4wv8-2f99). `package.json` `overrides` forces it to `esbuild@0.25.12`, so `npm audit` and OSV report 0 vulnerabilities. If a `drizzle-kit` upgrade drops that dependency, remove the override.
