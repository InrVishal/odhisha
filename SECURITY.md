# Security

Target: **OWASP ASVS 4.0 Level 2**, covering the **OWASP Top 10 (2021)**. This file maps each control to the code that implements it and the test that proves it. It grows every phase. Rows marked ⏳ are not built yet.

To report a vulnerability, email the team rather than opening a public issue.

## OWASP Top 10 mapping

| Risk | Control | Where | Proven by |
| --- | --- | --- | --- |
| A01 Broken access control | Server-side session check in every route handler, server action and protected page. Proxy is not trusted as an auth boundary | `lib/auth/guards.ts` | E2E redirect check (manual in phase 1); IDOR suite per resource ⏳ phase 3/5 |
| A01 | Admin role lives only in the DB and is re-read on every admin call. No UI or API can change it | `lib/db/schema.ts` (`user.role`), `requireAdmin()` | ⏳ phase 5 admin tests |
| A01 | Framing blocked | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | `tests/unit/headers.test.ts`, `scripts/check-headers.mjs` |
| A02 Cryptographic failures | Node tokens: 256-bit random, stored as SHA-256 | `lib/security/tokens.ts`, `node_token.token_hash` | `tests/unit/tokens.test.ts`, `tests/integration/schema.test.ts` |
| A02 | Magic-link tokens stored hashed (Auth.js), single use, 15-minute expiry | `lib/auth/index.ts` | Manual: reused link → `/signin/error` |
| A02 | HSTS (2 years, subdomains, preload) | `lib/security/headers.ts` | `headers.test.ts`, `check-headers.mjs` |
| A02 | Per-fragment data keys wrapped with `DATA_ENCRYPTION_KEY` | schema column `fragment.wrapped_key` | ⏳ phase 3 |
| A03 Injection | All SQL through Drizzle (parameterized). `sql.raw` and string-built SQL are banned | `lib/db/client.ts`, `.semgrep.yml` (`no-raw-sql`, `no-string-built-sql`) | Semgrep in CI |
| A03 | Zod on every input boundary, with size limits | `lib/env.ts`, `app/signin/actions.ts` | `tests/unit/env.test.ts`; more per phase |
| A03 / XSS | Strict CSP with per-request nonces and `strict-dynamic`. No `unsafe-inline`, no `unsafe-eval` in production. `dangerouslySetInnerHTML` and `eval` banned | `proxy.ts`, `lib/security/headers.ts`, `.semgrep.yml` | `headers.test.ts`, `check-headers.mjs`, Semgrep |
| A04 Insecure design | Ledgers and audit log are append-only, enforced by DB triggers. Balances are sums, never stored | `drizzle/0001_append_only.sql` | `schema.test.ts` (UPDATE/DELETE/TRUNCATE rejected) |
| A04 | Idempotency keys on every ledger row | `*_ledger.idempotency_key` unique | `schema.test.ts` |
| A04 | Agents never run buyer code: only whitelisted workload types with digest-pinned images | `workload_type` enum | ⏳ phase 4 |
| A05 Security misconfiguration | Env validated with Zod at boot. Dev-only backends refused when deployed | `lib/env.ts`, `instrumentation.ts` | `env.test.ts` |
| A05 | Full header set: CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP. `X-Powered-By` removed | `lib/security/headers.ts`, `next.config.ts` | `headers.test.ts`, `check-headers.mjs` (preview and production) |
| A05 | Generic error pages. Details never reach the browser | `app/error.tsx`, `app/signin/error`, `lib/auth/email.ts` | `tests/unit/email.test.ts` (provider body not leaked) |
| A06 Vulnerable components | Lockfile committed, exact versions pinned, Dependabot (npm, pip, actions), `npm audit --audit-level=high`, OSV scanner, `pip-audit`. Actions pinned to commit SHAs | `.github/` | CI job 4 |
| A07 Auth failures | No passwords. Email magic link everywhere, plus Google (verified emails only) on origins whose redirect URI is registered | `lib/auth/index.ts`, `lib/auth/google.ts` | `tests/unit/google.test.ts`; Playwright ⏳ phase 5 |
| A07 | "Log out of all devices" deletes every session for the account and is audited (`auth.logout_all`) | `lib/auth/sessions.ts`, `app/dashboard/actions.ts` | `tests/integration/sessions.test.ts` |
| A07 | Database sessions. httpOnly, SameSite=Lax cookies, Secure with the `__Secure-` prefix when deployed. New session on every login, and the browser's previous session is revoked | `lib/auth/index.ts` (`revokeIncomingSession`) | Manual, verified on a local prod build; Playwright ⏳ |
| A07 | Rate limits: login per IP (10/15 min) and per email (3/15 min). 429 with `Retry-After` | `lib/ratelimit.ts`, `app/api/auth/[...nextauth]/route.ts` | `tests/unit/ratelimit.test.ts`; manual: 11th POST → 429 |
| A07 | CSRF: Auth.js double-submit token on its endpoints; Next.js Server Actions check the Origin header | Auth.js, Next.js defaults (left on) | Manual: POST without token → `MissingCSRF` |
| A08 Integrity failures | Coordinator signs every task (Ed25519). Agent verifies signature, expiry and nonce. Agent updates only from signed releases | `COORDINATOR_SIGNING_KEY` | ⏳ phase 4 |
| A08 | gitleaks pre-commit hook and CI full-history scan | `.githooks/pre-commit`, `.gitleaks.toml` | CI job 4 |
| A09 Logging failures | Audit log: logins, logouts, rate-limit hits (later: token create/revoke, payouts, admin actions, quarantines). IPs stored only as an HMAC | `lib/audit.ts` | `schema.test.ts` (IP never stored) |
| A09 | Sentry with PII scrubbing | – | ⏳ phase 8 |
| A10 SSRF | No server-side fetching of user-supplied URLs. The only outbound call is to a fixed Resend URL | `lib/auth/email.ts` | Code review; Semgrep |

## Data protection (India DPDP Act)

- **Minimisation**: we never store a name, profile picture or OAuth tokens (`lib/auth/adapter.ts`, proven in `schema.test.ts`). Google is asked for `openid email` only. IPs are stored only as a keyed hash.
- **Account deletion and data export**: ⏳ phase 5. Users are never hard-deleted because ledger rows reference them. Deletion scrubs personal fields and sets `deleted_at`, and deleted accounts can't log in.
- **Retention**: job inputs and outputs are deleted after 7 days by default (`job.purge_after`). ⏳ phase 3.

## What this does NOT protect against (so far)

- **A node sees the plaintext of the fragment it computes.** Encryption at rest protects stored data, not data while a GPU works on it. Splitting jobs into fragments limits how much of a job any one node sees. It does not hide that fragment. Don't send data you can't let a stranger's PC see.
- **The in-memory rate limiter** (dev only) is per process. Deployed environments must use Upstash, and env validation enforces it.
- **Client IP for rate limits** comes from `x-real-ip` / `x-forwarded-for`. On Vercel these are set by the platform. Anywhere else, a client can spoof them.
- **Sessions on other devices** stay valid after a new login, until they expire (7 days). "Log out of all devices" on the dashboard ends them all at once.
- **Google login is not available on Vercel preview URLs.** Google needs every redirect URI registered exactly, with no wildcards, and each preview gets a new URL. Google is offered only on origins listed in `AUTH_GOOGLE_REDIRECT_ORIGINS` (localhost and production), and previews use the email link. This is expected, not a bug. Don't set Google credentials in the Vercel Preview environment.
- **Auth.js v5 is still beta** (`next-auth@5.0.0-beta.32`, pinned exactly). It's the only Auth.js line for the App Router. Dependabot will offer upgrades, and each one has to pass the auth tests.
- **Magic links on previews need Resend with a verified domain.** Without one, Resend only delivers to the account owner's own address.
- **Moderate advisory, dev-only**: `drizzle-kit` pulls an old `esbuild` (GHSA-67mh-4wv8-2f99, affects esbuild's dev server, which we never run). It is not in the production bundle, and CI fails only on high or critical.
