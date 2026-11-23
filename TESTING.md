# Testing

Every suite below runs in CI (`.github/workflows/ci.yml`) and must pass before a deploy. Each one runs locally with a single command.

| # | Suite | Command | Status |
| --- | --- | --- | --- |
| 1 | Unit (Vitest, incl. fast-check property tests) | `npm run test:unit` | ✅ |
| 1 | Unit + integration with coverage (90% lines on `lib/`) | `npm run test:coverage` | ✅ |
| 2 | Integration against Postgres, as the least-privilege `app_runtime` role | `npm run test:integration` | ✅ |
| 2 | Canary classifier, n = 1000 per class (its own CI job) | `CANARY_CLASSIFIER=1 npx vitest run tests/integration/canary.test.ts -t "n = 1000"` | ✅ |
| 3 | Security tests (IDOR on every resource, missing session, CSRF, tampered signatures, replayed nonces, oversized payloads, banned file types, rate limits, tokens, headers, append-only) | part of `npm test` and `npm run test:e2e` | ✅ more each phase |
| 4 | Agent (pytest, 90%+ coverage; sandbox escape tests run real containers when Docker is up) | `cd agent && pytest --cov` | ✅ |
| 4 | Agent static checks: ruff, `mypy --strict`, bandit, pip-audit | `cd agent && ruff check . && ruff format --check . && mypy && bandit -r src -c pyproject.toml && pip-audit -r requirements.lock` | ✅ |
| 4 | Live agent test: the real agent completes a real embedding fragment on the preview, the buyer downloads it | CI step in the preview job (`tests/live/agent-preview.ts`) | ✅ |
| 5 | End-to-end (Playwright: Chromium, Firefox, WebKit, mobile) | `npm run build && npm run test:e2e` | ✅ site flows; full job flow ⏳ phase 5 |
| 6 | Accessibility (axe-core on every page, zero serious/critical) + keyboard-only | `npm run build && npm run test:a11y` | ✅ |
| 7 | Lighthouse CI (90+ every category, median of 3) | `npx @lhci/cli@0.16.1 autorun --config=lighthouserc.cjs` (set `LHCI_BASE_URL`) | ✅ configured, see notes |
| 7 | k6 load on the **PR preview on Vercel with Neon** (on demand: label a PR `load-test`; `.github/workflows/load-preview.yml`). 200 VUs for 3 min from one runner, against a preview deployment of the PR's commit on a Neon branch copied from the PR's preview branch (deleted afterwards). Pass: p95 < 300 ms on quote, lease, heartbeat and hand-in counting **successful responses only**, < 1% failed requests, zero 429s and zero 5xx per endpoint. The only setting that differs from the PR preview is `AGENT_IP_LIMIT_PER_MIN` (all virtual PCs share the runner's IP; refused in production). Prints the Vercel, Upstash and Neon quota it used. On every push, CI job 9 runs the same users against 3 local processes and judges only failures, 429s and 5xx (its timings describe the runner) | label `load-test` on the PR | on demand + CI job 9 |
| 8 | Semgrep (rules tested with `semgrep --test tools/semgrep`) + CodeQL + gitleaks + npm audit + OSV + pip-audit + Trivy (workload images) + zizmor (workflows) | CI job `4 · Security scans` | ✅ |
| 8 | Bundle scan: no secrets, server-only names or source maps in anything a browser downloads | `npm run build && node scripts/scan-bundle.mjs` | ✅ |
| 8 | Smoke test (exposed files, source maps, admin 404s, error pages): build, every preview, production after deploy | `node scripts/smoke.mjs <url>` | ✅ |
| 8 | Database exposure (no Data API/GraphQL, TLS only, roles without powers) on each preview branch | `tests/live/db-exposure.ts` | ✅ |
| 8 | OWASP ZAP full (active) scan against this run's preview and its own Neon branch only (the job refuses any other target). `.zap/rules.tsv` sets injection/XSS/SSRF/traversal rules to FAIL; every WARN has a reviewed reason. Summary in the log, no report upload | CI job `7 · OWASP ZAP full scan` | CI |
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

**Phase 5** (dashboards):
- **Unit** (`tests/unit/pdf.test.ts`): the PDF writer's xref offsets and stream lengths are exact; text can't break out of a `Tj` operator; ₹ and dashes are mapped, other non-ASCII replaced; the invoice lists every quote line, the charge, the total paid, and a refund line with ₹0 paid when the deadline was missed.
- **Integration** (`tests/integration/dashboard.test.ts`, `account.test.ts`, against Postgres):
  - invoices: a PDF download for the buyer of a finished job; the refund line added automatically after a missed deadline; 404 for other buyers and bad ids, 401 signed out, 409 before the quote is confirmed;
  - owner views: earnings per PC with electricity separate, every piece a PC ran, scoped to the owner;
  - Time-Bank balance per user;
  - admin views: nodes, quarantine list, jobs, all three ledgers merged newest first, audit log, with no contact data;
  - data export: everything about the account and nothing about anyone else, no internal keys or hashes, audited, rate limited;
  - account deletion: email, logins, PC access and job data removed; ledger rows kept under the account id; refused while a job runs; open quotes cancelled; typed confirmation, same-site request and a session required; rate limited.
- **E2E** (`tests/e2e/dashboard.spec.ts`):
  - every run, every browser: each dashboard page sends a signed-out visitor to the login page; the header's Log in link; the invoice needs a session;
  - on every preview, signed in with sessions the live agent test creates (owner, buyer, admin), after the real agent finished a real job: the buyer sees the finished job and downloads its results, invoice and data export; quote errors show in the form; the owner sees the PC with estimated watts, earnings with electricity separate and every piece, adds a PC (token shown once), pauses and removes it; the admin sees every panel section and a non-admin gets a 404; every dashboard page has one h1 and no serious axe issues.

**Phase 6** (verification, trust, quarantine):
- **Unit** (`tests/unit/verify.test.ts`): about 1 piece in 10 is picked, at least one, distinct and in range (property test), and every piece can be picked; embeddings agree despite float noise but not when made up, reordered, scaled or the wrong count; captions agree with small wording differences but not different content; image sizes read from PNG, JPEG and all three WebP headers, and resized images agree only with the same type, dimensions and a similar file size; trust rises by 20, falls by 250, and stays in 0–1000; a new PC survives one failed check, not two; a released PC is quarantined again by one more failure.
- **Integration** (`tests/integration/verification.test.ts`, against Postgres):
  - pieces are flagged when the buyer confirms, not before;
  - a check runs on a different PC after the job has finished, pays the checker, and raises both PCs' trust; the PC that did the piece never gets its check;
  - with only one PC the check waits without failing anything, until the 7-day purge cancels it;
  - a disagreement blames nobody until a third PC settles it; when it sides with the checker, the first PC loses trust, its compute pay is reversed (electricity stays), and the buyer's download now has the agreed answer;
  - when it sides with the first PC, the checker is blamed; when all three disagree, everyone loses a little;
  - quarantine below trust 200: the agent is refused (403), its held work goes back in the queue for another PC, it's audited; owners and non-admins get a 404 on release, an admin can release once (then 409), audited with the admin's id.
- **Live** (`tests/live/agent-preview.ts`, every preview): after the real agent finishes the job, a second real agent on its own node picks up the check, runs the same piece in its own container, and the coordinator compares the two: the job reports 1 matched check and both PCs have trust 520.
- **E2E** (`tests/e2e/dashboard.spec.ts`): the buyer's job page shows the matched check; the owner's PC shows trust 520 and "1 passed, 0 failed".

**Phase 7** (Time-Bank, EMI simulator, anti-cheat hardening):
- **Unit**: `tests/unit/timebank.test.ts` (weighting frozen at 1.0× for every score, credit cost = GPU-seconds + 12% rounded up), `tests/unit/check-rate.test.ts` (50% for the first 20 pieces, falling with trust, never below 10%, back up at low trust; property tests), `tests/unit/emi.test.ts` (textbook EMI, 0% loans, schedule ends at exactly ₹0 and principal adds up for any loan, electricity never counts towards the EMI, payoff months, no-work case), `tests/unit/sybil.test.ts` (/24 and /48 networks, keyed hashes, UPI normalising and masking, who may check whom), `tests/unit/challenge.test.ts` (250 realistic sentences, case-flipped copies instead of all caps).
- **Integration**: `tests/integration/timebank.test.ts` (credits instead of compute pay, electricity still paid; pending until the check matches or 24 h pass; clawed back when corrected, inconclusive, unverifiable at purge, or on quarantine; spend only verified credits, oldest first; a refused confirm leaves the quote untouched; two racing confirms can't share credits; refund on a missed deadline, once; expiry after 6 months, once; credits never reach the owner ledger; the enum has no cash-out type; append-only), `tests/integration/canary.test.ts` (known-answer canary flow; never sent to the same account; the classifier test).
- **Real model**: three fallback challenges built from the realistic templates, run through the pinned `text_embeddings` image in Docker: 3 of 3 passed (duplicates and case-flipped copies cosine 1.00000; near > far in every triple, e.g. 0.96 > 0.16).
- **Live**: the first CI agent earns credits for the job's piece, released when the second agent's check matches; the two accounts on one CI machine are flagged for a shared device and network.

**Attack table** (`tests/integration/attacks.test.ts`, one test per attack, plus the files named):

| Attack | Detected | How fast | Consequence |
| --- | --- | --- | --- |
| Random or lazy outputs on a real job | Yes, when the piece is re-run (10–50% of a PC's pieces, by trust) | When a second (and third) PC has re-run it | Trust 500→250, compute pay reversed, credits clawed back, buyer's piece replaced with the agreed result; pay held until then |
| Cheating only while new (or after losing trust) | Yes, far more likely | Half of a new PC's first 20 pieces are re-run | As above; two failures quarantine a new PC |
| Random or lazy answers to a canary | Yes, every time | Made-up challenge: on hand-in. Known-answer canary: after a tie-break on another PC | Trust −250, audited (`node.canary_failed`); a second failure quarantines |
| Answering canaries honestly and cheating on real work | Known-answer canaries can't be told apart (classifier at chance, `canary.test.ts`); made-up fallback challenges can | As for any check | As for any check |
| Slightly wrong outputs (beyond float noise) | Yes, when re-run | As above | As above. Float noise (cosine ≥ 0.995) is accepted by design |
| Replayed result: another piece's output | Yes | On hand-in (422) | Counted as a failed check (trust −250), piece requeued |
| Replayed result: same hand-in twice | Yes | On hand-in (409) | Paid once |
| Inflated benchmark | Yes: the claim is ignored | Immediately | Score comes only from canaries timed on the coordinator's clock (median of 5, outliers dropped); credits don't use it (1.0×) |
| Inflated watts | Yes | On the report | Clamped to the class ceiling, audited |
| Lease hoarding | Yes | On the second lease request ("busy"), and at expiry | Piece requeued; trust −25 per lapsed lease, quarantine below 200 |
| Many fake PCs on one account | Yes | At lease and check time | 20 PCs per account; they never check each other |
| Fake accounts sharing a payout UPI ID | Yes | When the second account links it | Refused (409), both accounts flagged |
| Fake accounts on one machine | Yes, unless the agent is modified | On heartbeat | Flagged; never check each other |
| Fake accounts on one network | Yes (also catches honest hostels: flag only) | On heartbeat / lease | Flagged; never check each other |
| Earning credits for unverified work | Yes | Credits stay pending until verified | Clawed back if corrected, inconclusive, unverifiable before the purge, or the PC is quarantined first |
| Spending the same credits twice | Yes | At confirm (row lock) | The second confirm gets 409 `not_enough_credits` (`timebank.test.ts`) |
| Cashing out credits | Not possible | n/a | No entry type, function or route turns credits into money (`timebank.test.ts`) |
| Payout held | n/a | While a check is open, or the PC is quarantined | `heldPaise` in `/api/earnings` and on the dashboard |

**Phase 8** (security lockdown, canary-only verification, credits per unit of work):
- **Unit**: `totp.test.ts` (RFC 6238 test vectors, ±1 step, no reuse), `scan-bundle.test.ts` (finds planted secret values, patterns, server-only names, source maps), `env.test.ts` (ADMIN_EMAILS, TLS-verified database URLs), `emi.test.ts` (40% default, the pricing page's rate, payoff at 20/40/70%).
- **Integration** (all as `app_runtime`): `admin.test.ts` (A2–A5, B), `db-roles.test.ts` (privileges table by table and column by column; readonly), `mass-assignment.test.ts` (A1), `canary-only.test.ts` (E1, E3), `api-security.test.ts` (IDOR on every resource), `canary.test.ts` (E5, n = 1000 per class, its own CI job).
- **Live, every preview**: the deployment runs as `app_runtime` (admin reports as `readonly`), `db-exposure.ts`, `smoke.mjs`, and in a real browser: the admin sets up an authenticator; buyer and owner get 404s on `/admin`, every admin API method and the admin server actions called by ID.

**Attack table, Phase 8 additions:**

| Attack | Detected | How fast | Consequence |
| --- | --- | --- | --- |
| One person's PCs (lab, 3-laptop demo) vouching for each other | Yes: they never check each other | At lease time | The check goes canary-only: pay held until a later canary passes, no trust gain; a failed canary (or a replay) reverses the pay of every covered piece and claws back its credits (`canary-only.test.ts`) |
| Earning more credits by being slow | Not possible | n/a | Credits count the work (reference GPU-seconds of the piece), not the time taken (`timebank.test.ts`) |
| Telling known-answer canaries from real work | No better than chance | n/a | Upper 95% bound of a classifier's held-out accuracy ≤ 0.55 at n = 1000 per class (`canary.test.ts`) |
| Making yourself admin through the app | Not possible | n/a | No input takes `role`; the app's DB role can't write it; the trigger undoes it for any other role, audits it and emails the admins (`admin.test.ts`, `mass-assignment.test.ts`) |
| Admin with only one key (DB role or allowlist) | Yes | Every request | 404 (`admin.test.ts`) |
| Stolen admin session older than 15 minutes, or without the code | Yes | Every request | Admin pages ask to log in again / for the code; admin API 403 (`admin.test.ts`) |
| Calling an admin server action by its ID | Yes | Every call | 404, nothing happens (`dashboard.spec.ts`) |
| Spoofed `x-middleware-subrequest` or role headers | Ignored | n/a | 404 (`admin.test.ts`, `smoke.mjs`) |
| Reading the database directly (REST, GraphQL, SQL from the app) | Not possible | n/a | No Data API/GraphQL, no user SQL, least-privilege roles (`db-exposure.ts`, Semgrep, `db-roles.test.ts`) |
| Fetching `/.env`, `/.git/config`, source maps | 404 | n/a | `smoke.mjs` on the build, previews and production |
| Another site reading a page or API (CORS) | No allow headers, even for a hostile Origin | n/a | `smoke.mjs` |
| Malformed Server Action payloads (a number where the form goes) | Validation error, not a 500 | n/a | `form.test.ts`; ZAP 30003 |
| Making the preview send email (scanners, strangers) | Dropped unless on `PREVIEW_EMAIL_ALLOWLIST` | n/a | `email.test.ts` |
