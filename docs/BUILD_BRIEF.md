# Build prompt: NightShift (paste this whole file into your coding agent)

You are a senior full-stack engineer and security engineer. Build **NightShift**, a working prototype of a distributed GPU compute network, and deploy it on Vercel. Work in phases. At the end of each phase, run every test, fix what fails, and give me a short report: what you built, what's tested, what's still open. Don't move to the next phase with failing tests or open high/critical security findings.

Do not fake anything silently. If something is mocked (payments, EMI, real GPUs), label it clearly in the code and in the UI as "demo mode".

---

## 1. What NightShift is

NightShift turns idle GPUs in gaming PCs, cyber cafés and college labs into one compute pool. Owners run a small agent on their machine and earn money overnight. Buyers (AI startups, researchers, students) submit jobs and get a fixed price and a guaranteed finish time up front.

Four things make it different, and the product must show all four:

1. **Fixed price + deadline guarantee.** Buyers get a quote before running (example: "₹340, done by 6:00 AM"). If the deadline is missed, the buyer pays ₹0.
2. **Power-aware pricing.** Every price covers the owner's electricity first.
3. **Compute Time-Bank.** Students earn credits for hours their machine contributes and spend them later on a temporary multi-GPU cluster.
4. **GPU on EMI (simulated).** A GPU's network earnings auto-repay its EMI. Demo mode only: no real lending.

### Pricing formula (implement exactly, as a pure, fully tested function)

```
power_cost_per_hr  = node_kw × tariff_per_kwh          (default tariff ₹9/kWh, owner can set their own)
base_per_hr        = power_cost_per_hr + owner_rate_per_hr
job_cost           = Σ over fragments (gpu_hours × base_per_hr)
job_cost_buffered  = job_cost × (1 + verification_buffer)   (default 0.12)
platform_fee       = job_cost_buffered × fee_rate            (default 0.25)
price              = round_up_to_rupee(job_cost_buffered + platform_fee)
```

- Return a breakdown with these lines: owner payout, electricity, verification buffer, NightShift fee, total.
- Use integer paise for all money math, never floats.
- Default draws: RTX 3060 PC 0.32 kW, RTX 4070 PC 0.35 kW, RTX 4090 PC 0.60 kW. Once a node reports real watts, use those instead.
- Owner payout always includes their electricity. Add a test proving the owner can never be paid less than their power cost.

---

## 2. Tech stack (use these unless there is a strong reason not to, and tell me if you change one)

- **Web:** Next.js (App Router, latest stable) + TypeScript (strict) + Tailwind CSS
- **DB:** Postgres on Neon, accessed through Drizzle ORM. Migrations are checked into the repo.
- **Auth:** Auth.js with email magic link + Google. No passwords stored by us.
- **Queue / rate limiting:** Upstash Redis + `@upstash/ratelimit`
- **Validation:** Zod on every input boundary (forms, API, agent messages, env vars)
- **Background ticks:** Vercel Cron, for deadline checks, fragment timeouts and payout settlement
- **Monitoring:** Sentry (with PII scrubbing) + Vercel Analytics
- **Node agent:** Python 3.11 CLI, packaged so it installs with `pipx install`
- **Tests:** Vitest, Playwright, pytest, fast-check (property tests), k6 (load), axe-core (accessibility)

**Architecture rule:** Vercel only hosts the website and the coordinator API. Real compute runs on the owners' machines, through the agent. Agents poll the API for work (pull, not push), so no inbound ports are opened on anyone's machine.

---

## 3. What to build

### 3a. Public website (marketing)

Pages:
- **Home**
- **How it works**
- **For GPU owners**
- **For AI builders**
- **Pricing**, with a live calculator: pick a GPU class, hours, and your tariff → see the full breakdown, including electricity
- **Time-Bank**
- **FAQ**
- **Waitlist**
- **Privacy**
- **Terms**

Design: dark night-sky theme. Navy `#2A508D`, deep `#16264A`, lavender `#DDE1FF`, orange accent `#FFA629`. Moon, stars and network-node motifs. Must be responsive and fast: Lighthouse 90+ on every category.

### 3b. Buyer dashboard
- Submit a job. Only whitelisted workload types are allowed (see security). Start with these:
  - **Batch text embeddings** (sentence-transformers, small model)
  - **Batch image captioning or resizing**
- Get a quote with the full breakdown and finish time → confirm → watch progress (fragments done, nodes working) → download results.
- Job history, invoices (PDF), and a deadline-miss refund shown automatically.

### 3c. Owner dashboard
- Register a node. This generates a one-time install token, shown once.
- Node list: online/offline, GPU, benchmark score, measured watts, trust score.
- Earnings, with power reimbursement shown separately.
- Time-Bank credit wallet.
- EMI simulator (demo mode).
- Night window settings (for example 11 PM–7 AM), plus a pause button.

### 3d. Coordinator API
- Job splitting into fragments, node matching (by benchmark, perf-per-watt, availability, trust), leasing with timeouts, retries, and backup execution of slow fragments near the deadline.
- **Verification:** re-run a random 10% of fragments on a different node, compare outputs within tolerance, update trust scores, and quarantine nodes that fail.
- Ledger tables are append-only: owner earnings, buyer charges, credits. Never update balances in place.
- Payments and UPI payouts are simulated in demo mode. Make the interface swappable so Razorpay test mode can be plugged in later.

### 3e. Node agent (Python)
- `nightshift-agent login <token>`, `start`, `status`, `pause`
- Benchmarks the GPU on first run, and reports real power draw from `nvidia-smi` every 30 seconds.
- Runs each fragment in a Docker container: no network, read-only filesystem except a temp dir, CPU/RAM/GPU and time limits.
- Falls back to CPU mode for laptops without NVIDIA, for the demo.

### 3f. Admin panel
- Nodes, jobs, quarantine list, ledger view, audit log.
- Admin role is set in the DB only, never through the UI.

---

## 4. Website copy rules (the text must not read as AI-written)

Write like a small student team from Hyderabad explaining their product to a friend. A real person should be able to read every line out loud without cringing.

**Never use these words or phrases:** seamless, seamlessly, leverage, unlock, empower, revolutionize, cutting-edge, state-of-the-art, robust, game-changer, harness, elevate, delve, supercharge, unleash, next-gen, effortless, transformative, synergy, holistic, "in today's fast-paced world", "whether you're X or Y", "not just X, it's Y", "say goodbye to", "look no further", "the future of", "at the intersection of".

**Do this instead:**
- Short sentences. Plain words. One idea per sentence.
- Be specific. "₹3.2 an hour in electricity for an RTX 4070 PC" beats "cost-efficient compute".
- Use Indian context naturally: ₹, UPI, lakh, cyber café, hostel, exam week, hackathon.
- Address the reader as "you", and say "we" for the team.
- No three-adjective lists. No emoji in headings. Em dashes very rarely.
- Headlines say what happens, not how it feels. Example: "Your GPU earns while you sleep." Not: "Experience the power of distributed compute."
- Every claim must be true for the prototype. No fake testimonials, user counts, logos or "trusted by" sections.
- Mark examples as examples ("for example", "sample quote").

**After writing the copy**, run a script that greps the built site for the banned list and fails CI if it finds any of them. Then show me all the page copy in one file (`COPY.md`) so I can edit it.

---

## 5. Security requirements (treat as hard requirements)

Target **OWASP ASVS Level 2** and cover the **OWASP Top 10**. Write a `SECURITY.md` that maps each item to where it is handled and which test proves it.

### Owners' machines (the most important part)
- **Agents never run arbitrary buyer code.** They only run workload types from a whitelist, using pinned, versioned container images (digest-pinned, not `latest`). Buyers send data plus parameters, never scripts.
- Every task is signed by the coordinator (Ed25519). The agent verifies the signature, expiry and nonce before running anything, and rejects replays.
- Containers run with no network, as a non-root user, with dropped capabilities, seccomp default, a read-only root and resource and time limits.
- No `shell=True` and no eval anywhere in the agent. The agent updates only from signed releases.

### Web app and API
- Authorization is checked server-side on every route and server action. Every query is scoped to the current user's ID. Write a test for each resource proving user A cannot read or change user B's jobs, nodes, earnings or files (no IDOR).
- Zod validation on all inputs, with size limits. Parameterized queries through Drizzle only, no raw SQL string building.
- Auth.js sessions use secure, httpOnly, SameSite=Lax cookies. Rotate the session on login. CSRF protection stays on.
- Node tokens are random 256-bit values, shown once and stored as SHA-256 hashes. They can be revoked from the dashboard.
- Rate limits on login, waitlist, quote, job submit and all agent endpoints. Return 429 with Retry-After.
- Headers (in `next.config` / middleware):
  - Strict CSP with nonces: no `unsafe-inline` or `unsafe-eval`
  - HSTS (preload-ready)
  - `X-Content-Type-Options: nosniff`
  - `frame-ancestors 'none'`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - Tight `Permissions-Policy`
- Uploads: allowlisted MIME types checked by magic bytes, size caps, random object keys, served with `Content-Disposition: attachment`, and never executed.
- No server-side fetching of user-supplied URLs (prevents SSRF). If one is ever needed, use an allowlist and block private IP ranges.
- Secrets live only in Vercel environment variables. Validate env vars with Zod at boot. Nothing secret in `NEXT_PUBLIC_*`. Add a gitleaks pre-commit hook and CI step.
- Errors show users a generic message. Details go to Sentry with PII scrubbed. Never leak stack traces.
- Audit log for logins, token creation and revocation, payouts, admin actions and quarantines.
- Data minimisation in line with India's DPDP Act: collect only what's needed. Include account deletion and data export.
- Encrypt job data at rest. Each fragment gets its own key. Delete inputs and outputs after 7 days by default.
- Dependencies: lockfiles committed, Dependabot on, `npm audit` / `pip-audit` / OSV scanner in CI, and fail on high or critical findings.

Be honest in `SECURITY.md` about what this does *not* protect against. For example, a node does see the plaintext of the fragment it computes. Say that splitting into fragments limits how much any one node sees.

---

## 6. Testing (every level, all in CI, all must pass before deploy)

1. **Unit (Vitest):**
   - Pricing function, including property tests with fast-check: price ≥ power cost + owner pay, and no rounding loss in paise.
   - Scheduler matching, trust score updates, ledger math, Zod schemas.
   - Target: 90%+ coverage on `lib/`.
2. **Integration:** API routes against a real Postgres test database (Neon branch or Docker). Covers authz, the job lifecycle, timeouts and retries, and verification mismatches leading to quarantine.
3. **Security tests (written as normal tests):** IDOR for every resource, missing or expired session, tampered agent signature, replayed nonce, oversized payloads, rate-limit hits, banned file types, and CSP/header presence.
4. **Agent (pytest):**
   - Signature verification and replay rejection.
   - Container flags actually applied (inspect the docker run args).
   - Kill on timeout, power telemetry parsing, CPU fallback.
5. **End-to-end (Playwright):** sign up → register node → simulated agent connects → buyer gets quote → job runs → results download → owner sees earnings plus power line → deadline-miss refund path. Run on Chromium, Firefox and WebKit, plus a mobile viewport.
6. **Accessibility:** axe-core on every page, with zero serious or critical issues. Keyboard-only navigation works.
7. **Performance:**
   - Lighthouse CI 90+ on all categories for public pages.
   - k6 load test on quote and agent poll endpoints: p95 under 300 ms at 200 virtual users.
8. **Static and dynamic security scanning:**
   - Semgrep and CodeQL in CI.
   - OWASP ZAP baseline scan against every Vercel preview deployment.
   - Fail the pipeline on high-severity findings.
9. **Copy check:** the banned-words script from section 4.

Write a `TESTING.md` that lists every suite and how to run it locally with one command each.

---

## 7. Vercel deployment

- GitHub repo with a protected `main`. Every PR gets a Vercel preview deployment plus its own Neon database branch.
- The GitHub Actions pipeline runs, in order:
  1. lint and typecheck
  2. unit tests
  3. integration tests
  4. security scans
  5. build
  6. E2E against the preview
  7. ZAP against the preview
  8. Lighthouse
- `main` deploys to production only if the whole pipeline is green.
- Separate environment variables for Development, Preview and Production. Production secrets never appear in previews.
- Vercel Cron jobs for scheduler ticks. Secure them with a `CRON_SECRET` header check.
- Run DB migrations as a deploy step, with a rollback plan written in `DEPLOY.md`.
- Add Sentry release tracking and uptime monitoring for the API health endpoint.
- Custom domain with HTTPS. Check the security headers on production with a test that runs after deploy.

---

## 8. Build order

1. Repo setup, CI skeleton, env validation, security headers, auth, DB schema plus migrations
2. Pricing engine and public website with live calculator and final copy, plus `COPY.md`
3. Coordinator API: jobs, fragments, scheduler, ledger, cron ticks
4. Python agent with sandboxed execution and signed tasks
5. Buyer, owner and admin dashboards
6. Verification, trust scores and quarantine
7. Time-Bank and EMI simulator (demo mode)
8. Full test pass, security hardening, ZAP clean, load test, production deploy
9. Final report, covering:
   - live URL
   - how to run the demo with 3 laptops
   - test results summary
   - remaining risks
   - what I should get an external pentester to check

---

## 9. Definition of done

- Live on Vercel, with three laptops able to join and complete a real batch-embedding job end to end.
- Every test suite green in CI, and zero high or critical findings from Semgrep, CodeQL, dependency scans and ZAP.
- `README.md`, `SECURITY.md`, `TESTING.md`, `DEPLOY.md` and `COPY.md` are all written.
- No banned words in the site copy. Nothing fake on the site.
