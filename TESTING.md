# Testing

Every suite below runs in CI (`.github/workflows/ci.yml`) and must pass before a deploy. Each one runs locally with a single command.

| # | Suite | Command | Status |
| --- | --- | --- | --- |
| 1 | Unit (Vitest, incl. fast-check property tests) | `npm run test:unit` | ✅ |
| 1 | Unit + integration with coverage (90% lines on `lib/`) | `npm run test:coverage` | ✅ |
| 2 | Integration against Postgres | `npm run test:integration` | ✅ |
| 3 | Security tests (headers, rate limits, tokens, append-only, data minimisation, Google origin gating) | part of `npm test` and `npm run test:e2e` | ✅ more each phase |
| 4 | Agent (pytest) | `cd agent && pytest` | ⏳ phase 4 |
| 5 | End-to-end (Playwright: Chromium, Firefox, WebKit, mobile) | `npm run build && npm run test:e2e` | ✅ site flows; full job flow ⏳ phase 5 |
| 6 | Accessibility (axe-core on every page, zero serious/critical) + keyboard-only | `npm run build && npm run test:a11y` | ✅ |
| 7 | Lighthouse CI (90+ every category, median of 3) | `npx @lhci/cli@0.16.1 autorun --config=lighthouserc.cjs` (set `LHCI_BASE_URL`) | ✅ configured, see notes |
| 7 | k6 load (p95 < 300 ms at 200 VUs) | `k6 run load/quote-and-poll.js` | ⏳ phase 8 |
| 8 | Semgrep + CodeQL + gitleaks + npm audit + OSV | CI job `4 · Security scans` (Semgrep locally: `semgrep scan --config .semgrep.yml`) | ✅ configured |
| 8 | OWASP ZAP baseline against the preview | CI job `7 · OWASP ZAP baseline` | ✅ configured |
| 9 | Banned-words copy check (source, COPY.md sync, and the built site) | `npm run build && npm run copy:check` | ✅ |
| – | Live security-header check | `node scripts/check-headers.mjs <url>` | ✅ |

## Running Playwright locally

`npm run test:e2e` starts the built app itself (`next start` on port 3300, in-memory database), so run `npm run build` first. Browsers are a one-time download: `npx playwright install` (or `npx playwright install chromium` for just one). For one browser: `npx playwright test --project=chromium`.

Against a deployed preview: `E2E_BASE_URL=https://… npm run test:e2e`. Tests that write rate-limited data (waitlist signups) then run in Chromium only, because every request comes from one IP.

## Lighthouse notes

- **Vercel previews send `X-Robots-Tag: noindex`**, so the SEO "is-crawlable" audit is skipped on previews and checked on production after deploy (`LHCI_PRODUCTION=1`).
- **Performance is noisy on a busy machine.** Lighthouse simulates a slow phone CPU, so anything else running inflates Total Blocking Time. CI takes the median of 3 runs. Locally, close other heavy apps before measuring.
- Reports stay private (CI artifact `lighthouse`). Public report upload is off, because report settings would include the Vercel protection-bypass header.

## Integration database

- **Locally**: each test file gets a fresh in-memory PGlite database (real Postgres 17 in WASM). Nothing to install.
- **In CI** (or locally with Docker): set `TEST_DATABASE_URL` to a Postgres server. Each test file creates its own throwaway database there and drops it afterwards.

```sh
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:integration
```

## What's covered so far

**Phase 1**: env validation, security headers and nonces, node tokens, cron auth, rate limits, append-only ledgers and audit log, idempotency keys, check constraints, auth data minimisation, logout audit, log out of all devices, Google shown only on registered origins.

**Phase 2**:
- **Pricing**, with worked examples and fast-check properties at 2,000 runs each:
  - the owner is never paid less than their power cost;
  - the owner payout always includes electricity;
  - price ≥ power cost + owner pay;
  - the breakdown lines add up to the total exactly (no rounding loss);
  - every amount is a whole number of paise, and the total is whole rupees;
  - the result stays within ₹1.12 of the exact formula;
  - more hours never cost less;
  - fragment order doesn't matter.
- **Parsing**: rupees and hours are parsed and formatted with string maths, never floats.
- **Copy**: no banned words, no em dashes in source copy, every placeholder filled, examples labelled, demo mode stated, no social-proof claims. The check runs on the built site too.
- **Theme**: every text/background colour pair passes WCAG AA.
- **Waitlist**: Zod rules, consent required, a repeat signup is a silent no-op with the same message shown, and the per-IP limit returns the rate-limit message.
- **Browser (Playwright)**:
  - axe on all 13 pages;
  - a skip link and exactly one h1 and one `main` per page;
  - the calculator works keyboard-only;
  - the waitlist works keyboard-only;
  - the mobile menu opens with the keyboard;
  - no horizontal scroll at phone width;
  - no inline styles in server HTML;
  - no console or CSP errors.
