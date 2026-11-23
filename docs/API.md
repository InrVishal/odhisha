# Coordinator API

All responses are JSON with `Cache-Control: no-store` and a deny-all CSP. Errors are always `{ "error": "<code>", "message": "<safe text>" }`, plus `fields` (names only, never values) on validation errors. Unknown errors are a bare `500 internal`.

Payments are simulated (**demo mode**): no money moves.

## Buyer (session cookie)

Writes need a same-origin `Origin` header.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/jobs/quote` | Text jobs: JSON `{ workloadType: "text_embeddings", gpuClass, params, texts: [...] }`. Image jobs: `multipart/form-data` with a `request` field (JSON `{ workloadType, gpuClass, params }`) and `images` files | 201 `{ job }` with price, breakdown and deadline. Held 10 minutes. 503 `no_capacity` if no PC of that class can finish it tonight. Max 5 open quotes. Limited to 30 a minute |
| POST | `/api/jobs/{id}/confirm` | – | Charges (simulated) and queues the job. 409 `quote_expired` / `not_quoted`. Limited to 10 a minute |
| POST | `/api/jobs/{id}/cancel` | – | Only for a quote that hasn't been confirmed. Deletes its data now |
| GET | `/api/jobs` | – | The buyer's last 50 jobs |
| GET | `/api/jobs/{id}` | – | Status, progress (`fragmentsDone`, `fragmentsTotal`, `nodesWorking`), `refunded`, `netChargedPaise`, and `checks` (`planned`, `matched`, `corrected`, `inconclusive`, `waiting`): the pieces re-run on a second PC and how that went |
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
| GET / PATCH | `/api/nodes/{id}` | Any of `name`, `tariffPaisePerKwh`, `ownerRatePaisePerHr`, `nightWindowStartMin`, `nightWindowEndMin` (minutes after midnight; start = end means all day), `timezone`, `paused` | |
| POST | `/api/nodes/{id}/token` | – | New token, shown once. Old ones stop working |
| DELETE | `/api/nodes/{id}/token` | – | Revoke every token. The agent is locked out, and its work goes back in the queue |
| GET | `/api/earnings` | – | `computePayPaise`, `powerReimbursementPaise` (its own line), `paidOutPaise`, `balancePaise` |

Node management is limited to 20 requests an hour.

## Account (session cookie)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/account/export` | – | Everything stored about the account as a JSON download: account, PCs, jobs, all three ledgers, own activity log. No idempotency keys, IP hashes or token hashes |
| DELETE | `/api/account` | `{ "confirm": "DELETE" }` | Removes the email and every login, revokes every PC token, deletes all stored job data now. Ledger rows stay under the account id. 409 `jobs_running` while a job is queued or running. Clears the session cookie |

Both are limited to 5 requests an hour.

## Admin (session cookie, role `admin` in the database)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/admin/nodes/{id}/release` | – | Lets a quarantined PC work again, with trust just above the quarantine line. Anyone who isn't an admin (checked in the database on every call) gets a 404. 409 `not_quarantined` |

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
