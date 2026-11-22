# NightShift

NightShift pools idle GPUs from gaming PCs, cyber cafés and college labs into one compute network. GPU owners run a small agent and earn money overnight. Buyers get a fixed price and a finish time before their job runs, and pay ₹0 if we miss the deadline.

**Status: prototype, phase 2 of 9 done.** Payments, UPI payouts and GPU EMI are simulated ("demo mode") and will stay that way in this prototype.

## Run it locally

You need Node 22.12 or newer. No database server or accounts are needed for local dev.

```sh
npm install
cp .env.example .env.local     # then fill AUTH_SECRET and CRON_SECRET (32+ chars each)
npm run dev                    # http://localhost:3000 (the local PGlite database in ./.pglite migrates itself)
```

To log in locally, enter any email on `/signin`. With `EMAIL_TRANSPORT=console` the login link is printed in the terminal running `npm run dev`.

## Layout

| Path | What it is |
| --- | --- |
| `app/(marketing)/` | Public site: home, how it works, owners, builders, pricing (calculator), Time-Bank, FAQ, waitlist, privacy, terms, login |
| `app/` | Other routes: dashboard, API |
| `content/site.ts` | **All public site copy.** COPY.md is generated from it |
| `content/derived.ts` | Numbers in the copy, computed by the pricing engine |
| `components/` | Header, footer, night-sky art, content blocks |
| `lib/pricing.ts` | The pricing formula: integer paise, BigInt maths, shared by server and browser |
| `lib/copy/banned.ts` | Banned-word list and checks used by `npm run copy:check` |
| `proxy.ts` | Per-request CSP nonce and security headers (Next 16 renamed `middleware` to `proxy`) |
| `lib/env.ts` | Zod validation of every environment variable, run at server boot |
| `lib/security/` | Header builders, token generation and hashing |
| `lib/auth/` | Auth.js config, data-minimising adapter, authorization guards |
| `lib/db/` | Drizzle schema and driver selection (Neon / node-postgres / PGlite) |
| `lib/ratelimit.ts` | Rate-limit policies (Upstash in deployed envs) |
| `lib/audit.ts` | Append-only audit log writer |
| `drizzle/` | SQL migrations (checked in). `0001` adds the append-only triggers |
| `tests/` | Vitest unit and integration suites; Playwright in `tests/e2e/` |
| `docs/BUILD_BRIEF.md` | The original build brief |
| `.github/workflows/` | CI/CD pipeline, CodeQL, preview cleanup |

## Stack, and where we changed it

We follow the stack in the build brief, with these differences:

- **Next.js 16.4**: `middleware.ts` is now `proxy.ts`. `cacheComponents` (Partial Prerendering) is off, because a nonce-based CSP needs every page rendered per request.
- **Auth.js v5 is still in beta** (`next-auth@5.0.0-beta.32`). It's the only Auth.js line that supports the App Router, so we pin the exact version.
- **Magic-link email goes through Resend**, because the brief didn't name a provider. Locally the link is printed to the console.
- **Local and test database: PGlite**, which is real Postgres compiled to WASM. This machine has no Docker. CI runs the integration suite against a real `postgres:17` service container (through `node-postgres`). Preview and production use Neon, as the brief says.

## Docs

- [SECURITY.md](SECURITY.md): each security control, where it lives, and the test that proves it
- [TESTING.md](TESTING.md): every test suite and the one command that runs it
- [COPY.md](COPY.md): every word of site copy, for editing (generated, see the top of the file)
- `DEPLOY.md` is added in phase 8
