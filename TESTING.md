# Testing

Every suite below runs in CI (`.github/workflows/ci.yml`) and must pass before a deploy. Each one runs locally with a single command.

| # | Suite | Command | Status |
| --- | --- | --- | --- |
| 1 | Unit (Vitest) | `npm run test:unit` | ✅ phase 1 |
| 1 | Unit + integration with coverage (90% lines on `lib/`) | `npm run test:coverage` | ✅ phase 1 |
| 2 | Integration against Postgres | `npm run test:integration` | ✅ phase 1 |
| 3 | Security tests (headers, rate limits, tokens, append-only, data minimisation) | part of `npm test` | ✅ phase 1, more each phase |
| 4 | Agent (pytest) | `cd agent && pytest` | ⏳ phase 4 |
| 5 | End-to-end (Playwright: Chromium, Firefox, WebKit, mobile) | `npm run test:e2e` | ⏳ phase 5 |
| 6 | Accessibility (axe-core, zero serious/critical) | `npm run test:a11y` | ⏳ phase 2 |
| 7 | Lighthouse CI (90+ every category) | `npx @lhci/cli@0.16.1 autorun --config=lighthouserc.cjs` | config ready; pages in phase 2 |
| 7 | k6 load (p95 < 300 ms at 200 VUs) | `k6 run load/quote-and-poll.js` | ⏳ phase 8 |
| 8 | Semgrep + CodeQL + gitleaks + npm audit + OSV | CI job `4 · Security scans` (Semgrep locally: `semgrep scan --config .semgrep.yml`) | ✅ configured |
| 8 | OWASP ZAP baseline against the preview | CI job `7 · OWASP ZAP baseline` | ✅ configured |
| 9 | Banned-words copy check | `node scripts/check-copy.mjs` | ⏳ phase 2 |
| – | Live security-header check | `node scripts/check-headers.mjs <url>` | ✅ phase 1 |

## Integration database

- **Locally**: each test file gets a fresh in-memory PGlite database (real Postgres 17 in WASM). Nothing to install.
- **In CI** (or locally with Docker): set `TEST_DATABASE_URL` to a Postgres server. Each test file creates its own throwaway database there and drops it afterwards.

```sh
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:integration
```

## What phase 1 covers

- **Env validation**: dev-only backends (PGlite, console email, in-memory rate limits) are refused in preview and production, secret-looking `NEXT_PUBLIC_*` names are refused, and error messages never contain values.
- **Headers**: the production CSP has no `unsafe-inline` and no `unsafe-eval`, each request gets a fresh 128-bit nonce, the renderer receives the same nonce, API routes get a deny-all CSP, and HSTS, Permissions-Policy and the other headers are all present.
- **Tokens**: node tokens are 256-bit, stored as SHA-256 hashes, and malformed tokens are rejected. The cron bearer check matches only the exact secret.
- **Rate limits**: a request over the limit gets a 429 with `Retry-After`. Every policy the spec lists exists.
- **Database**: migrations apply cleanly. UPDATE, DELETE and TRUNCATE are rejected on all four append-only tables. Idempotency keys block double-booking. Users referenced by the ledger can't be hard-deleted. Check constraints are enforced.
- **Auth data minimisation**: no name, picture or OAuth tokens are stored. Logout is attributable in the audit log.
