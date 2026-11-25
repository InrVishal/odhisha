# Coordinator API

All responses are JSON with `Cache-Control: no-store` and a deny-all CSP. Errors are always `{ "error": "<code>", "message": "<safe text>" }`, plus `fields` (names only, never values) on validation errors. Unknown errors are a bare `500 internal`.

Payments are simulated (**demo mode**): no money moves.

## Buyer (session cookie)

Writes need a same-origin `Origin` header.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/jobs/quote` | Text jobs: JSON `{ workloadType: "text_embeddings", gpuClass, params, texts: [...], canaryReuse? }`. Image jobs: `multipart/form-data` with a `request` field (JSON `{ workloadType, gpuClass, params, canaryReuse? }`) and `images` files. `canaryReuse` (default true): may verified pieces be re-run on other PCs as known-answer canaries. Unknown fields (`role`, `ownerId`, ...) are a 400 | 201 `{ job }` with price, breakdown and deadline. Held 10 minutes. 503 `no_capacity` if no PC of that class can finish it tonight. Max 5 open quotes. Limited to 30 a minute |
| POST | `/api/jobs/{id}/confirm` | none, or `{ payWith: "money" \| "credits" }` | Queues the job. `money` (default): charges (simulated). `credits`: spends verified Time-Bank credits (the quote's `creditCost`, oldest-expiring first; 409 `not_enough_credits`). 409 `quote_expired` / `not_quoted`. Limited to 10 a minute |
| POST | `/api/jobs/{id}/cancel` | – | Only for a quote that hasn't been confirmed. Deletes its data now |
| GET | `/api/jobs` | – | The buyer's last 50 jobs |
| GET | `/api/jobs/{id}` | – | Status, progress (`fragmentsDone`, `fragmentsTotal`, `nodesWorking`), `refunded`, `netChargedPaise`, `creditCost` (while quoted: the price in standard GPU-seconds), `creditsSpent` (null when paid in money), `checks` (`planned`, `matched`, `corrected`, `inconclusive`, `waiting`): the pieces re-run on a second PC and how that went, `canaryOnly` (`waiting`, `passed`, `failed`): pieces no independent PC could check, verified by canaries instead, and `canaryReuse` |
| GET | `/api/jobs/{id}/results` | – | A streamed download (`Content-Disposition: attachment`): `{ jobId, workloadType, items: [...] }`, one item per input, in input order. 409 until the job finishes, 410 after the 7-day purge |
| GET | `/api/jobs/{id}/invoice` | – | The invoice as a PDF download: the quote breakdown, the charge and, if the deadline was missed, the refund line. 409 `no_invoice` until the quote is confirmed |

Workloads (`lib/coordinator/workloads.ts`):

| `workloadType` | `params` | Items | Result per item |
| --- | --- | --- | --- |
| `text_embeddings` | `model`: `"all-MiniLM-L6-v2"`, `normalize`: bool | up to 5,000 texts, each up to 8 KB, 3 MB in total | 384 numbers |
| `image_captioning` | `model`: `"blip-base"`, `maxWords`: 5–40 | up to 200 PNG/JPEG/WebP, each up to 1 MB, 3 MB in total | a caption |
| `image_resize` | `width`, `height` (1–4096), `fit`: `cover`/`contain`/`inside`, `format`: `png`/`jpeg`/`webp`, `quality` | as above | `{ mime, data }` (base64) |

`gpuClass`: `rtx3060`, `rtx4070`, `rtx4090` or `cpu` (laptops, demo).

## Owner (session cookie)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/nodes` | `{ name, gpuClass }` | 201 `{ node, token }`. **The token is shown once.** Up to 20 PCs per owner |
| GET | `/api/nodes` | – | The owner's PCs, with `available`, `unavailableReason`, `trustScore`, `checksPassed`, `checksFailed` |
| GET / PATCH | `/api/nodes/{id}` | Any of `name`, `tariffPaisePerKwh`, `ownerRatePaisePerHr`, `nightWindowStartMin`, `nightWindowEndMin` (minutes after midnight; start = end means all day), `timezone`, `paused`, `earnsCredits` | GET also returns `piecesDone` and `checkRate` (the share of its pieces re-run now, 0.1–0.5) |
| POST | `/api/nodes/{id}/token` | – | New token, shown once. Old ones stop working |
| DELETE | `/api/nodes/{id}/token` | – | Revoke every token. The agent is locked out, and its work goes back in the queue |
| GET | `/api/earnings` | – | `computePayPaise`, `powerReimbursementPaise` (its own line), `paidOutPaise`, `balancePaise`, `heldPaise` (pieces waiting for their check, and everything a quarantined PC earned), `availablePaise` |

| GET | `/api/credits` | – | Time-Bank wallet: `availableSec` (verified, unexpired), `pendingSec`, `expiringSoonSec`, `earnedSec`, `spentSec`, `clawedBackSec`, `expiredSec`, `balanceSec`, the last 50 rows, `weighting: "1.0x (frozen)"`, `cashable: false` |

Node management is limited to 20 requests an hour.

**Time-Bank.** A PC with `earnsCredits` earns credits (standard GPU-seconds of the piece, weighting frozen at 1.0×) instead of compute pay for pieces of buyers' jobs; electricity is still paid in rupees, and checks and lost races are paid in rupees. Credits are pending until verified (the check matched, or not picked for a check and 24 h passed with the PC in good standing), clawed back if the piece is corrected, its check is inconclusive, its check can't run before the 7-day purge, or the PC is quarantined first, and expire after 6 months. They can only be spent on jobs; there is no cash-out or transfer endpoint.

## Account (session cookie)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/account/export` | – | Everything stored about the account as a JSON download: account, PCs, jobs, all three ledgers, own activity log. No idempotency keys, IP hashes or token hashes |
| POST | `/api/account/upi` | `{ upiId }` | Links the payout UPI ID (`name@bank`). One UPI ID per account: 409 `upi_in_use` if another account has it (both are flagged for review). Stored as a keyed hash plus a masked copy. Payouts are simulated |
| DELETE | `/api/account` | `{ "confirm": "DELETE" }` | Removes the email and every login, revokes every PC token, deletes all stored job data now. Ledger rows stay under the account id. 409 `jobs_running` while a job is queued or running. Clears the session cookie |

All three are limited to 5 requests an hour.

## Admin (session cookie; see SECURITY.md, "Admin")

Admin = role `admin` in the database **and** the email on `ADMIN_EMAILS`, plus a login from the last 15 minutes and an authenticator code on that session (set up and entered at `/admin`). Anyone else gets a 404 on every admin route and method; an admin without the step-up gets 403 `admin_step_up`.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/admin/nodes/{id}/release` | – | Lets a quarantined PC work again, with trust just above the quarantine line. Audited. 409 `not_quarantined`. GET/PUT/PATCH/DELETE: 404 |

## Prices

Every job costs at least **₹10** (`MIN_JOB_PRICE_PAISE`). A smaller job is topped up, and the top-up is part of the fee line (`breakdown.minimumTopUpPaise` says how much). Owners are paid the same either way.

## Anti-cheat

- **Challenges:** the coordinator sends each PC signed pieces it made up itself: a new PC's first piece, then about 1 in 20 leases, at most once an hour. They look like any text-embedding piece. The hidden structure (duplicates, UPPERCASE copies, near and far sentences) catches made-up answers (`node.canary_failed`, trust −250, no pay), and the coordinator's own clock times them. A PC's speed score is the median of its last 5 passed runs, with runs more than 2× off the median dropped, after 3 runs. The `benchmarkScore` an agent sends in its heartbeat is stored as `reportedBenchmark` and used for nothing.
- **One piece at a time:** `POST /api/agent/lease` answers `{ task: null, reason: "busy" }` while the PC holds an unexpired lease. A lease that runs out costs the PC 25 trust.
- **Replays:** handing in output that already belongs to a different piece is refused with 422 `replayed_output`, and counts as a failed check.
- **Watts:** reports above the class ceiling (CPU 150 W, RTX 3060 450 W, RTX 4070 550 W, RTX 4090 900 W) are clamped and audited (`node.watts_clamped`).

## Canaries, checking rates and fake accounts

- **Known-answer canaries:** once pieces exist that two PCs of different owners agreed on, a canary is a re-run of one of them, sent to a third PC as an ordinary check (same input, item count, workload, parameters and lease length as real work). A disagreement goes to a tie-break on another PC before anyone is blamed. The made-up challenges above are only used when no such piece is available.
- **Checking rate per PC:** 50% of a new PC's first 20 pieces; then falling with trust (500 → 50%, 700 → 30%, 900 → 10%), never below 10%; back to 50% at trust 500 or less. Pieces picked at confirm time (about 10%, at least one per job) are always checked; the rest get the extra chance that brings the PC to its rate.
- **Sybil rules:** the agent's heartbeat may carry `deviceId` (64 hex: a salted hash of the machine ID). The coordinator stores a keyed hash of it and of the network each PC calls from (/24 or /48). PCs on different accounts sharing either are flagged (`sybil.flagged` in the audit log, shown in the admin panel). A check is never given to a PC on the same account, device or network as any PC that ran the piece. Preview deployments set `SYBIL_CHECKER_RULES=report` (flag only, since CI's test agents share one machine); production refuses that setting.

## Verification

About 1 piece in 10 of every job (at least one) is picked when the buyer confirms. Once a picked piece is done, a **verification copy** is queued. It looks like any other task to an agent, and it's never given to a PC that ran or holds another copy of the same piece. Checks are leased after every other kind of work and never hold up a job. When the outputs disagree, a third PC breaks the tie. See `lib/coordinator/verification.ts`.

## Agent (`Authorization: Bearer nsn_…`)

Agents only ever call out. Owners' PCs never accept inbound connections. Limits: 600 requests a minute per IP (checked before the token is looked up) and 240 a minute per node.

| Method | Path | Body | Reply |
| --- | --- | --- | --- |
| GET | `/api/agent/signing-key` | (public) | `{ alg: "Ed25519", kid, publicKeyPem }`. Pin it at install |
| POST | `/api/agent/heartbeat` | `{ watts?, gpuModel?, vramMb?, benchmarkScore?, agentVersion? }` | `{ status, paused, canWork, reason, pollAfterSec }`. Send one every 30 s. Silence for 90 s means offline |
| POST | `/api/agent/lease` | `{}` | `{ task, input, leaseExpiresAt }`, or `{ task: null, reason, pollAfterSec }` |
| POST | `/api/agent/fragments/{taskId}/complete` | the output JSON `{ "items": [...] }`, with headers `X-Lease-Attempt` and `X-Output-Sha256` | `{ accepted, paidPaise }`. `accepted: false` means another copy won; you're still paid. 409 `lease_lost`, 422 `bad_output`, 400 `digest_mismatch`. Max 4 MB |
| POST | `/api/agent/fragments/{taskId}/fail` | `{ attempt, reason }` | `{ requeued }` |

`task` is `{ task: "<JSON text>", signature: "<base64 Ed25519>", kid }`. Before running anything, the agent must:

1. Verify the signature over the exact bytes of `task.task` with the pinned key.
2. Parse that text and check `v == 1`, `exp` is in the future, `nodeId` is its own id, and the `nonce` hasn't been seen before (remember each nonce until its `exp`).
3. Check that `workload` and `image` are on its own built-in whitelist.
4. Base64-decode `input` and check its sha256 equals `inputSha256`.

Input is `{"texts": [...]}` or `{"images": [{name, mime, data}]}`.

## Cron

`GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`. Vercel Cron calls it daily (Hobby plan). The same tick also runs, at most once every 15 seconds, whenever an agent asks for work or a buyer views a job. Each tick:

- expires leases;
- marks silent PCs offline;
- starts backup copies;
- refunds missed deadlines;
- clears expired quotes;
- purges job data after 7 days.
