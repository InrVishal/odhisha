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
| A01 | Admin role lives only in the DB and is re-read on every admin call. No UI or API can change it | `lib/db/schema.ts` (`user.role`), `requireAdmin()` | ⏳ phase 5 admin tests |
| A01 | Framing blocked | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | `tests/unit/headers.test.ts`, `scripts/check-headers.mjs` |
| A02 Cryptographic failures | Node tokens: 256-bit random, stored as SHA-256 | `lib/security/tokens.ts`, `node_token.token_hash` | `tests/unit/tokens.test.ts`, `tests/integration/schema.test.ts` |
| A02 | Magic-link tokens stored hashed (Auth.js), single use, 15-minute expiry | `lib/auth/index.ts` | Manual: reused link → `/signin/error` |
| A02 | `upgrade-insecure-requests` on every page served over HTTPS (all deployed environments). Left off on plain-HTTP local servers, where WebKit would otherwise break every asset | `lib/security/headers.ts`, `proxy.ts` | `headers.test.ts` |
| A02 | HSTS (2 years, subdomains, preload) | `lib/security/headers.ts` | `headers.test.ts`, `check-headers.mjs` |
| A02 | Job data encrypted at rest: AES-256-GCM with a random key per piece, wrapped with `DATA_ENCRYPTION_KEY`. Associated data binds each ciphertext to its job and key, so blobs and wrapped keys can't be swapped between rows | `lib/security/envelope.ts`, `lib/coordinator/store.ts` | `tests/unit/crypto.test.ts`, `coordinator.test.ts` (no plaintext in the DB) |
| A02 | Separate signing and data keys per environment (Production, Preview, local). Required when deployed; dev/test use random per-process keys, never a key in the source | `lib/security/keys.ts`, `lib/env.ts` | `env.test.ts`, `crypto.test.ts` |
| A03 Injection | All SQL through Drizzle (parameterized). `sql.raw` and string-built SQL are banned | `lib/db/client.ts`, `.semgrep.yml` (`no-raw-sql`, `no-string-built-sql`) | Semgrep in CI |
| A03 | Zod on every input boundary (strict objects: unknown keys refused), with size limits. Bodies are capped before and while reading (413). Validation errors name fields, never echo values | `lib/api/http.ts`, `lib/coordinator/*.ts` | `env.test.ts`, `workloads.test.ts`, `api-security.test.ts` |
| A03 / uploads | Images are typed by magic bytes only (PNG, JPEG, WebP). Name and Content-Type are ignored. SVG, GIF, HTML, PDF and executables are refused. Size and count caps per item and per job. Stored under random keys, never as files; results always download with `Content-Disposition: attachment` and `nosniff` | `lib/security/filetype.ts`, `lib/api/handlers.ts` | `workloads.test.ts`, `api-security.test.ts` |
| A03 / XSS | Strict CSP with per-request nonces and `strict-dynamic`. No `unsafe-inline`, no `unsafe-eval` in production. `dangerouslySetInnerHTML` and `eval` banned | `proxy.ts`, `lib/security/headers.ts`, `.semgrep.yml` | `headers.test.ts`, `check-headers.mjs`, Semgrep |
| A04 Insecure design | Ledgers and audit log are append-only, enforced by DB triggers. Balances are sums, never stored | `drizzle/0001_append_only.sql` | `schema.test.ts` (UPDATE/DELETE/TRUNCATE rejected) |
| A04 | Idempotency keys on every ledger row | `*_ledger.idempotency_key` unique | `schema.test.ts` |
| A04 | Agents never run buyer code. Three whitelisted workloads; buyers send data and enum/number parameters only, never scripts, model names outside the enum, or URLs. Agent output is validated against the workload's schema | `lib/coordinator/workloads.ts` | `workloads.test.ts`, `api-security.test.ts` |
| A04 | Digest-pinned container images per workload | `WORKLOADS[*].image` | ⏳ phase 4 (images are built there) |
| A04 | Money can't be created by racing or retrying: every state change is a conditional UPDATE, every ledger row has a unique idempotency key, a refund is booked at most once | `lib/coordinator/lifecycle.ts`, `lib/ledger.ts` | `coordinator.test.ts` (one refund row, paid once) |
| A04 | What owners are paid can never exceed what the buyer was quoted: quotes are priced per piece at the costliest available PC, and a PC that costs more can't take the job | `lib/coordinator/schedule.ts` (`withinCap`), `jobs.ts` | `scheduler.test.ts` (property test), `coordinator.test.ts` |
| A05 Security misconfiguration | Env validated with Zod at boot. Dev-only backends refused when deployed | `lib/env.ts`, `instrumentation.ts` | `env.test.ts` |
| A05 | Full header set: CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP. `X-Powered-By` removed | `lib/security/headers.ts`, `next.config.ts` | `headers.test.ts`, `check-headers.mjs` (preview and production) |
| A05 | Generic error pages. Details never reach the browser | `app/error.tsx`, `app/signin/error`, `lib/auth/email.ts` | `tests/unit/email.test.ts` (provider body not leaked) |
| A06 Vulnerable components | Lockfile committed, exact versions pinned, Dependabot (npm, pip, actions), `npm audit --audit-level=high`, OSV scanner, `pip-audit`. Actions pinned to commit SHAs | `.github/` | CI job 4 |
| A07 Auth failures | No passwords. Email magic link everywhere, plus Google (verified emails only) on origins whose redirect URI is registered | `lib/auth/index.ts`, `lib/auth/google.ts` | `tests/unit/google.test.ts`; Playwright ⏳ phase 5 |
| A07 | "Log out of all devices" deletes every session for the account and is audited (`auth.logout_all`) | `lib/auth/sessions.ts`, `app/dashboard/actions.ts` | `tests/integration/sessions.test.ts` |
| A07 | Database sessions. httpOnly, SameSite=Lax cookies, Secure with the `__Secure-` prefix when deployed. New session on every login, and the browser's previous session is revoked | `lib/auth/index.ts` (`revokeIncomingSession`) | Manual, verified on a local prod build; Playwright ⏳ |
| A07 | Rate limits: login per IP (10/15 min) and per email (3/15 min), quotes (30/min), job confirm/cancel (10/min), node management (20/hour), agents per IP (600/min, checked before any token lookup) and per node (240/min). 429 with `Retry-After` | `lib/ratelimit.ts`, `app/api/auth/[...nextauth]/route.ts`, `lib/api/handlers.ts` | `tests/unit/ratelimit.test.ts`, `api-security.test.ts` (every surface) |
| A07 | Node tokens: shown once at registration or rotation, stored only as SHA-256, revocable from the dashboard API. Revoking locks the agent out on its next request and frees its work | `lib/coordinator/nodes.ts`, `lib/coordinator/agent.ts` | `api-security.test.ts`, `coordinator.test.ts` |
| A07 | CSRF: Auth.js double-submit token on its endpoints; Next.js Server Actions check the Origin header | Auth.js, Next.js defaults (left on) | Manual: POST without token → `MissingCSRF` |
| A04 / A07 | Waitlist: Zod validation (email ≤ 254 chars, fixed interest values, consent required), 5 signups per IP per hour, and the same reply for new and existing emails (no way to check who signed up) | `lib/waitlist.ts`, `app/(marketing)/waitlist/actions.ts` | `tests/integration/waitlist.test.ts`; `tests/e2e/site.spec.ts` (repeat signup, rate limit) |
| A03 / XSS | Server HTML has no inline `style` attributes (a nonce doesn't cover them), and pages load with zero console or CSP errors | components use Tailwind classes only | `tests/e2e/site.spec.ts` |
| A08 Integrity failures | Coordinator signs every task with Ed25519 over the exact JSON bytes it sends: node id, attempt, workload, parameters, input sha256, expiry (= lease end), 128-bit nonce. Public key at `/api/agent/signing-key` | `lib/security/signing.ts`, `lib/coordinator/agent.ts` | `crypto.test.ts` (tampered, wrong key, expired, wrong node, replayed nonce), `coordinator.test.ts` (every task verifies), `tests/e2e/api.spec.ts` |
| A08 | Agent verifies signature, expiry, nonce and input hash before running anything; agent updates only from signed releases | `agent/` | ⏳ phase 4 |
| A08 | Agent outputs carry a sha256 that must match the body | `completeFragment` | `api-security.test.ts` |
| A08 | gitleaks pre-commit hook and CI full-history scan | `.githooks/pre-commit`, `.gitleaks.toml` | CI job 4 |
| A09 Logging failures | Audit log: logins, logouts, rate-limit hits, node registration and settings changes, token creation and revocation, job confirmation, refunds (later: payouts, admin actions, quarantines). IPs stored only as an HMAC | `lib/audit.ts` | `schema.test.ts` (IP never stored), `api-security.test.ts` (token events audited) |
| A09 | Sentry with PII scrubbing | – | ⏳ phase 8 |
| A10 SSRF | No server-side fetching of user-supplied URLs. Job inputs are uploaded data, never URLs; workload parameters reject unknown keys such as `url`. The only outbound call is to a fixed Resend URL | `lib/auth/email.ts`, `lib/coordinator/workloads.ts` | `workloads.test.ts`; code review; Semgrep |

## Data protection (India DPDP Act)

- **Minimisation**: we never store a name, profile picture or OAuth tokens (`lib/auth/adapter.ts`, proven in `schema.test.ts`). Google is asked for `openid email` only. IPs are stored only as a keyed hash.
- **Account deletion and data export**: ⏳ phase 5. Users are never hard-deleted because ledger rows reference them. Deletion scrubs personal fields and sets `deleted_at`, and deleted accounts can't log in.
- **Retention**: job inputs and outputs are deleted 7 days after a job ends (`job.purge_after`), an unconfirmed quote's data when the quote expires or is cancelled. Ledger rows stay (they hold no job data). Proven in `coordinator.test.ts`.

## What this does NOT protect against (so far)

- **A node sees the plaintext of the fragment it computes.** Encryption at rest protects stored data, not data while a GPU works on it. Splitting jobs into fragments limits how much of a job any one node sees. It does not hide that fragment. Don't send data you can't let a stranger's PC see.
- **The in-memory rate limiter** (dev only) is per process. Deployed environments must use Upstash, and env validation enforces it.
- **Client IP for rate limits** comes from `x-real-ip` / `x-forwarded-for`. On Vercel these are set by the platform. Anywhere else, a client can spoof them.
- **Sessions on other devices** stay valid after a new login, until they expire (7 days). "Log out of all devices" on the dashboard ends them all at once.
- **Google login is not available on Vercel preview URLs.** Google needs every redirect URI registered exactly, with no wildcards, and each preview gets a new URL. Google is offered only on origins listed in `AUTH_GOOGLE_REDIRECT_ORIGINS` (localhost and production), and previews use the email link. This is expected, not a bug. Don't set Google credentials in the Vercel Preview environment.
- **Auth.js v5 is still beta** (`next-auth@5.0.0-beta.32`, pinned exactly). It's the only Auth.js line for the App Router. Dependabot will offer upgrades, and each one has to pass the auth tests.
- **Magic links on previews need Resend with a verified domain.** Without one, Resend only delivers to the account owner's own address.
- **Benchmarks are self-reported** by the agent until verification (phase 6) can check them. They're capped at 10× an RTX 3060, and pay doesn't depend on them (owners are paid for a piece's priced time, not its run time), but a high claimed score can win work a PC then runs slowly. Leases, backups and the deadline refund limit the damage to the buyer.
- **The scheduler runs on traffic.** Vercel Hobby cron runs once a day, so the tick also runs (throttled to once per 15 s) whenever an agent asks for work or a buyer looks at a job. With no traffic at all, a missed deadline is refunded at the next request or the daily cron.
- **Job data lives in Postgres** (encrypted), not object storage, to keep the prototype on free tiers. Size caps (4 MB per request, 3 MB per job) keep it small.
- **Semgrep suppressions** (each is one rule on one line, with the reason beside it): `scripts/check-copy.ts`, `react-insecure-request`. The copy checker fetches pages over plain HTTP from the `next start` server it spawns on `127.0.0.1`. That's loopback to a local build, not a network request. List any new suppression here.
- **Pinned override**: `drizzle-kit` depends on the deprecated `@esbuild-kit/core-utils`, which asked for an old `esbuild` with a known advisory (GHSA-67mh-4wv8-2f99). `package.json` `overrides` forces it to `esbuild@0.25.12`, so `npm audit` and OSV report 0 vulnerabilities. If a `drizzle-kit` upgrade drops that dependency, remove the override.
