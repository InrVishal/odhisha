# Testing

Every suite below runs in CI (`.github/workflows/ci.yml`) and must pass before a deploy. Each one runs locally with a single command.

| # | Suite | Command | Status |
| --- | --- | --- | --- |
| 1 | Unit (Vitest, incl. fast-check property tests) | `npm run test:unit` | ✅ |
| 1 | Unit + integration with coverage (90% lines on `lib/`) | `npm run test:coverage` | ✅ |
| 2 | Integration against Postgres | `npm run test:integration` | ✅ |
| 3 | Security tests (IDOR on every resource, missing session, CSRF, tampered signatures, replayed nonces, oversized payloads, banned file types, rate limits, tokens, headers, append-only) | part of `npm test` and `npm run test:e2e` | ✅ more each phase |
| 4 | Agent (pytest, 90%+ coverage; sandbox escape tests run real containers when Docker is up) | `cd agent && pytest --cov` | ✅ |
| 4 | Agent static checks: ruff, `mypy --strict`, bandit, pip-audit | `cd agent && ruff check . && ruff format --check . && mypy && bandit -r src -c pyproject.toml && pip-audit -r requirements.lock` | ✅ |
| 4 | Live agent test: the real agent completes a real embedding fragment on the preview, the buyer downloads it | CI step in the preview job (`tests/live/agent-preview.ts`) | ✅ |
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

- **Two SEO audits can't pass on a protected preview**, so they're skipped there and checked on production after deploy (`LHCI_PRODUCTION=1`):
  - "is-crawlable": Vercel sends `X-Robots-Tag: noindex` on every preview.
  - "robots-txt": Lighthouse fetches `/robots.txt` without the Deployment Protection bypass header and gets a redirect to the Vercel login. `tests/e2e/site.spec.ts` checks robots.txt and sitemap.xml on every preview instead.
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

**Phase 3** (coordinator API):
- **Unit** (`tests/unit/scheduler.test.ts`, `workloads.test.ts`, `crypto.test.ts`, `payments.test.ts`):
  - night windows, including ones that wrap past midnight, all-day windows and the node's own time zone;
  - node availability (online, unpaused, recent heartbeat, trust, inside the window) and the matching score (benchmark, work per watt, trust);
  - the price cap: a PC that costs more than the quote assumed can't take the job;
  - planning: more PCs finish sooner; work that can't finish before the window closes is refused; the quoted deadline has slack and lands on a quarter hour (property test);
  - leases and the backup rule (slow AND near the deadline);
  - owner pay per piece never below power cost, and the quote always covers what every owner is paid, whichever PCs run it (property tests);
  - the workload whitelist: parameters only, no code, no unknown keys, size and count limits, magic-byte file types (SVG, GIF, HTML, PDF, executables refused), splitting keeps every item in order (property test), agent output validated per workload;
  - envelope encryption (tamper detection, AAD binding, a fresh key per piece) and Ed25519 task signing (tampered task, wrong key, expired, wrong node, replayed nonce).
- **Integration** (`tests/integration/coordinator.test.ts`, against Postgres):
  - a 600-text job split over two PCs, end to end: quote, confirm (simulated charge), signed tasks verified, results downloaded in order as an attachment, owners paid per piece with electricity as its own line;
  - measured watts and the owner's own tariff and rate flow into the quote;
  - no capacity, outside the night window, paused PCs, too many open quotes;
  - lease timeouts and retries, a late result refused, handing a piece back, out of attempts → job failed and refunded;
  - silent PCs marked offline and their work freed; a revoked token locks the agent out;
  - backup copies near the deadline: never on the same PC, first finisher wins, both owners paid once;
  - deadline missed → ₹0 with exactly one refund row, results still delivered, owners still paid;
  - job data encrypted at rest with a key per piece; quote expiry, cancel and the 7-day purge delete the data, ledgers stay;
  - the tick runs at most once per 15 s and is idempotent; the cron route needs `CRON_SECRET`.
- **Security** (`tests/integration/api-security.test.ts`): IDOR for jobs, results, nodes, tokens and earnings; one node can't complete another's lease; 401 on every endpoint without a session; cross-site writes refused; oversized bodies refused before and while reading; unknown fields, bad JSON, wrong content types; validation errors never echo values; output sha256 mismatch; SVG/HTML/EXE/GIF uploads refused whatever their name; 429 with Retry-After on every limited surface; token hash-only storage and audit.
- **Lifecycle demo**: `npm run build && npm run demo:lifecycle` runs one job end to end against a local server, with simulated PCs and a fake clock for the timing paths.
- **E2E** (`tests/e2e/api.spec.ts`, on every preview): the signing key is published, endpoints need a session or a node token, the cron route needs its secret, API responses carry the deny-all CSP and no stack traces.

**Phase 4** (agent):
- **Task checks** (`agent/tests/test_trust.py`):
  - every rejection reason: tampered task text, tampered or non-base64 signature, a task signed by another key (including one claiming our key id), expired, issued in the future, wrong node, replayed nonce (also after a restart), non-whitelisted workloads, wrong image (tag, other digest, other registry, extra flags, missing), input that doesn't match its hash, malformed fields;
  - a rejected task doesn't burn its nonce;
  - the pinned key's id matches the one the preview publishes.
- **Sandbox** (`agent/tests/test_sandbox.py`): the exact `docker run` argument list; `--gpus` only when asked; nothing that weakens isolation; digest-only images; output name sanitising (path traversal, `..`, slashes, hidden files, Windows reserved names, unicode, long names); oversized output; too many files; folders and symlinks; timeout hard kill; cleanup on every path; exit-code mapping.
- **Sandbox escape** (`agent/tests/test_sandbox_docker.py`, real containers): no network or DNS; uid/gid 65534; no capabilities; no-new-privileges; seccomp filter on; no writes outside `/tmp` and `/out`; `/tmp` is noexec; output folder not listable (Linux); fork bomb stopped at the pids limit; memory hog killed; timeout kill removes the container.
- **Agent loop** (`agent/tests/test_runner.py`): uploads with sha256 and power headers; CPU mode estimated watts; pause and the night window, including finishing the current fragment first; waits when the coordinator says so; reports unacceptable tasks; drops forged ones without trusting their ids; never runs a replay; maps sandbox failures; never runs past the lease; backoff and stop on a revoked token.
- **CLI, config, tokens, logs, telemetry, updates** (`test_cli.py`, `test_parts.py`):
  - HTTPS-only URLs (localhost only in dev mode);
  - token in the keyring or a 0600 file, never printed or logged;
  - TLS verification on;
  - exponential backoff with jitter;
  - nvidia-smi parsing;
  - the night window;
  - signed-release checks;
  - the benchmark runs once on the first start.
