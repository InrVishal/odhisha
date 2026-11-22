import { z } from "zod";
import { deleteAccount, exportAccount } from "@/lib/account";
import { AuthzError, type SessionUser } from "@/lib/auth/authz-error";
import { SESSION_COOKIE_NAMES } from "@/lib/auth/sessions";
import { audit } from "@/lib/audit";
import { authenticateAgent, completeFragment, failFragment, failInput, heartbeat, heartbeatInput, leaseFragment, parsePowerHeaders } from "@/lib/coordinator/agent";
import { CoordinatorError } from "@/lib/coordinator/errors";
import { cancelQuote, confirmJob, getJob, listJobs, openResults, quoteJob, quoteRequest, textQuoteRequest } from "@/lib/coordinator/jobs";
import { getNode, listNodes, registerNode, registerNodeInput, revokeNode, rotateNodeToken, updateNode, updateNodeInput } from "@/lib/coordinator/nodes";
import { maybeTick, runTick } from "@/lib/coordinator/tick";
import { MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES, WORKLOADS, type InputItem } from "@/lib/coordinator/workloads";
import type { Db } from "@/lib/db/client";
import { invoicePdf, loadInvoice } from "@/lib/invoice";
import { ownerEarnings } from "@/lib/ledger";
import type { LimitResult, PolicyName } from "@/lib/ratelimit";
import { sniffImageType } from "@/lib/security/filetype";
import type { CoordinatorKeys } from "@/lib/security/keys";
import { keyId, publicKeyPem } from "@/lib/security/signing";
import { clientIp, isAuthorizedCron } from "@/lib/security/tokens";
import { errorJson, handle, json, rateLimited, readBody, readJson } from "./http";

/**
 * API handlers, with every dependency passed in. The files under app/api/
 * are one-line wrappers that supply the real database, keys, session and
 * rate limiter; integration tests call these directly against a real
 * Postgres with a test clock and a test user.
 *
 * Order in every handler: rate limit → authenticate → authorize/scope →
 * validate → act. Nothing reads the database before the rate limit.
 */

export interface Deps {
  db: Db;
  now: () => Date;
  keys: CoordinatorKeys;
  /** Secret for hashing IPs in the audit log. */
  ipSecret: string;
  cronSecret: string;
  limit: (policy: PolicyName, key: string) => Promise<LimitResult>;
}

export interface UserDeps extends Deps {
  user: SessionUser | null;
}

function requireUser(d: UserDeps): SessionUser {
  if (!d.user) throw new AuthzError(401);
  return d.user;
}

/**
 * Cookie-authenticated writes must come from our own pages. SameSite=Lax
 * already keeps the session cookie off cross-site POSTs; this check is the
 * second lock (CSRF), using the Origin header browsers always send on POST.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return;
    } catch {
      // fall through
    }
  } else if (!origin && req.headers.get("sec-fetch-site") === "same-origin") {
    return;
  }
  throw new CoordinatorError(403, "cross_origin", "Cross-site requests aren't allowed.");
}

async function limitOr429(d: Deps, policy: PolicyName, key: string): Promise<Response | null> {
  const r = await d.limit(policy, key);
  return r.success ? null : rateLimited(r);
}

// ─── Buyer: jobs ───────────────────────────────────────────────────────────

const SAFE_NAME = /[^\p{L}\p{N} ._()-]/gu;

/** A display name for an uploaded file. Never used as a path or object key. */
function cleanName(name: string, i: number): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(SAFE_NAME, "_").slice(0, 100).trim();
  return cleaned || `image-${i + 1}`;
}

async function parseQuoteBody(req: Request): Promise<{ meta: z.infer<typeof quoteRequest>; items: InputItem[] }> {
  const type = req.headers.get("content-type") ?? "";
  if (/^application\/json\b/i.test(type)) {
    const body = await readJson(req, textQuoteRequest, MAX_REQUEST_BYTES);
    if (WORKLOADS[body.workloadType].itemKind !== "text") {
      throw new CoordinatorError(400, "wrong_item_kind", "Image jobs are uploaded as files (multipart/form-data).");
    }
    const { texts, ...meta } = body;
    return { meta, items: texts.map((text) => ({ kind: "text" as const, text })) };
  }
  if (/^multipart\/form-data\b/i.test(type)) {
    // Read with a hard cap first, then let the platform parse the copy.
    const bytes = await readBody(req, MAX_REQUEST_BYTES);
    const form = await new Request(req.url, { method: "POST", headers: { "content-type": type }, body: bytes }).formData();
    const rawMeta = form.get("request");
    if (typeof rawMeta !== "string") throw new CoordinatorError(400, "invalid_input", "Missing the request field.");
    let metaJson: unknown;
    try {
      metaJson = JSON.parse(rawMeta);
    } catch {
      throw new CoordinatorError(400, "bad_json", "The request field isn't valid JSON.");
    }
    const meta = quoteRequest.parse(metaJson);
    if (WORKLOADS[meta.workloadType].itemKind !== "image") {
      throw new CoordinatorError(400, "wrong_item_kind", "Text jobs are sent as JSON.");
    }
    const files = form.getAll("images");
    const items: InputItem[] = [];
    for (const [i, f] of files.entries()) {
      if (typeof f === "string") throw new CoordinatorError(400, "invalid_input", "images must be files.");
      const data = Buffer.from(await f.arrayBuffer());
      // The real type comes from the bytes. The client's Content-Type and the
      // file name are ignored.
      const mime = sniffImageType(data);
      if (!mime) throw new CoordinatorError(400, "bad_file_type", `File ${i + 1} isn't a PNG, JPEG or WebP image.`);
      items.push({ kind: "image", name: cleanName(f.name, i), mime, data });
    }
    return { meta, items };
  }
  throw new CoordinatorError(415, "unsupported_media_type", "Send JSON (text jobs) or multipart/form-data (image jobs).");
}

export function quoteHandler(req: Request, d: UserDeps): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "quoteUser", user.id);
    if (limited) return limited;
    const { meta, items } = await parseQuoteBody(req);
    const job = await quoteJob(
      { db: d.db, buyerId: user.id, now: d.now(), masterKey: d.keys.dataKey, ip: clientIp(req.headers), ipSecret: d.ipSecret },
      { workloadType: meta.workloadType, gpuClass: meta.gpuClass, params: meta.params, items },
    );
    return json({ job }, 201);
  });
}

function jobCtx(req: Request, d: UserDeps, user: SessionUser) {
  return { db: d.db, buyerId: user.id, now: d.now(), masterKey: d.keys.dataKey, ip: clientIp(req.headers), ipSecret: d.ipSecret };
}

export function confirmJobHandler(req: Request, d: UserDeps, jobId: string): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "jobSubmitUser", user.id);
    if (limited) return limited;
    return json({ job: await confirmJob(jobCtx(req, d, user), jobId) });
  });
}

export function cancelJobHandler(req: Request, d: UserDeps, jobId: string): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "jobSubmitUser", user.id);
    if (limited) return limited;
    return json({ job: await cancelQuote(jobCtx(req, d, user), jobId) });
  });
}

/** Runs the throttled tick; a failure never breaks the request that triggered it. */
async function tickQuietly(d: Deps): Promise<void> {
  try {
    await maybeTick(d.db, d.now(), d.ipSecret);
  } catch (err) {
    console.error("[tick] failed", err instanceof Error ? err.name : typeof err);
  }
}

export function getJobHandler(_req: Request, d: UserDeps, jobId: string): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    // A buyer checking on a job also moves the scheduler, so a missed
    // deadline is refunded as soon as they look, even with no agent polling.
    await tickQuietly(d);
    return json({ job: await getJob({ db: d.db, buyerId: user.id }, jobId) });
  });
}

export function listJobsHandler(_req: Request, d: UserDeps): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    await tickQuietly(d);
    return json({ jobs: await listJobs({ db: d.db, buyerId: user.id }) });
  });
}

export function resultsHandler(_req: Request, d: UserDeps, jobId: string): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    const { filename, stream } = await openResults({ db: d.db, buyerId: user.id, masterKey: d.keys.dataKey }, jobId);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // Always a download, never rendered in the page.
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
}

export function invoiceHandler(_req: Request, d: UserDeps, jobId: string): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    const inv = await loadInvoice(d.db, user.id, jobId);
    return new Response(Buffer.from(invoicePdf(inv)), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="nightshift-invoice-${inv.number}.pdf"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
}

// ─── Owner: nodes and earnings ─────────────────────────────────────────────

function nodeCtx(req: Request, d: UserDeps, user: SessionUser) {
  return { db: d.db, ownerId: user.id, now: d.now(), ip: clientIp(req.headers), ipSecret: d.ipSecret };
}

export function registerNodeHandler(req: Request, d: UserDeps): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "nodeManageUser", user.id);
    if (limited) return limited;
    const input = await readJson(req, registerNodeInput);
    const { node, token } = await registerNode(nodeCtx(req, d, user), input);
    // The token is in this response and nowhere else, ever.
    return json({ node, token, tokenShownOnce: true }, 201);
  });
}

export function listNodesHandler(_req: Request, d: UserDeps): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    return json({ nodes: await listNodes({ db: d.db, ownerId: user.id, now: d.now() }) });
  });
}

export function getNodeHandler(_req: Request, d: UserDeps, nodeId: string): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    return json({ node: await getNode({ db: d.db, ownerId: user.id, now: d.now() }, nodeId) });
  });
}

export function updateNodeHandler(req: Request, d: UserDeps, nodeId: string): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "nodeManageUser", user.id);
    if (limited) return limited;
    const patch = await readJson(req, updateNodeInput);
    return json({ node: await updateNode(nodeCtx(req, d, user), nodeId, patch) });
  });
}

export function rotateTokenHandler(req: Request, d: UserDeps, nodeId: string): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "nodeManageUser", user.id);
    if (limited) return limited;
    const { token } = await rotateNodeToken(nodeCtx(req, d, user), nodeId);
    return json({ token, tokenShownOnce: true }, 201);
  });
}

export function revokeNodeHandler(req: Request, d: UserDeps, nodeId: string): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "nodeManageUser", user.id);
    if (limited) return limited;
    await revokeNode(nodeCtx(req, d, user), nodeId);
    return json({ revoked: true });
  });
}

export function earningsHandler(_req: Request, d: UserDeps): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    return json({ earnings: await ownerEarnings(d.db, user.id), demo: true });
  });
}

// ─── Account: export and delete (DPDP access and erasure) ─────────────────

export function exportAccountHandler(req: Request, d: UserDeps): Promise<Response> {
  return handle(async () => {
    const user = requireUser(d);
    const limited = await limitOr429(d, "accountUser", user.id);
    if (limited) return limited;
    const now = d.now();
    const data = await exportAccount(d.db, user.id, now);
    await audit(d.db, { actorId: user.id, actorType: "user", action: "account.exported", targetType: "user", targetId: user.id, ip: clientIp(req.headers) }, d.ipSecret);
    return json(data, 200, {
      "Content-Disposition": `attachment; filename="nightshift-account-${now.toISOString().slice(0, 10)}.json"`,
    });
  });
}

const deleteAccountInput = z.strictObject({ confirm: z.literal("DELETE") });

export function deleteAccountHandler(req: Request, d: UserDeps): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = requireUser(d);
    const limited = await limitOr429(d, "accountUser", user.id);
    if (limited) return limited;
    await readJson(req, deleteAccountInput, 1024);
    const result = await deleteAccount(d.db, user.id, { now: d.now(), ip: clientIp(req.headers), ipSecret: d.ipSecret });
    // The sessions are gone from the database; clear the cookie too.
    const res = json({ deleted: true, ...result });
    for (const name of SESSION_COOKIE_NAMES) {
      res.headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${name.startsWith("__Secure-") ? "; Secure" : ""}`);
    }
    return res;
  });
}

// ─── Agent ─────────────────────────────────────────────────────────────────

async function agentAuth(req: Request, d: Deps) {
  // Per-IP limit first, so token guessing is throttled before any DB lookup.
  const ipLimited = await limitOr429(d, "agentIp", clientIp(req.headers));
  if (ipLimited) return { error: ipLimited };
  const authed = await authenticateAgent(d.db, req.headers.get("authorization"), d.now());
  if (!authed) return { error: errorJson(401, "bad_token", "Unknown or revoked node token.", { "WWW-Authenticate": "Bearer" }) };
  if (authed.node.status === "quarantined") {
    return { error: errorJson(403, "quarantined", "This PC is paused by NightShift after failed checks.") };
  }
  const nodeLimited = await limitOr429(d, "agentNode", authed.node.id);
  if (nodeLimited) return { error: nodeLimited };
  return { node: authed.node };
}

export function heartbeatHandler(req: Request, d: Deps): Promise<Response> {
  return handle(async () => {
    const a = await agentAuth(req, d);
    if (a.error) return a.error;
    const input = await readJson(req, heartbeatInput, 4 * 1024);
    return json(await heartbeat(d.db, a.node, input, d.now()));
  });
}

export function leaseHandler(req: Request, d: Deps): Promise<Response> {
  return handle(async () => {
    const a = await agentAuth(req, d);
    if (a.error) return a.error;
    const now = d.now();
    // Agent polls drive the scheduler (Hobby cron runs only daily).
    await tickQuietly(d);
    const { lease, reason } = await leaseFragment(d.db, a.node, now, d.keys);
    if (!lease) return json({ task: null, reason, pollAfterSec: reason === "no_work" ? 10 : 30 });
    return json(lease);
  });
}

const attemptHeader = z.coerce.number().int().min(1).max(100);

export function completeHandler(req: Request, d: Deps, fragmentId: string): Promise<Response> {
  return handle(async () => {
    const a = await agentAuth(req, d);
    if (a.error) return a.error;
    const attempt = attemptHeader.safeParse(req.headers.get("x-lease-attempt"));
    if (!attempt.success) throw new CoordinatorError(400, "invalid_input", "Send X-Lease-Attempt.");
    const type = req.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(type)) throw new CoordinatorError(415, "unsupported_media_type", "Send the output as JSON.");
    const body = await readBody(req, MAX_OUTPUT_BYTES);
    const reply = await completeFragment(d.db, a.node, {
      fragmentId,
      attempt: attempt.data,
      sha256: (req.headers.get("x-output-sha256") ?? "").toLowerCase(),
      body,
      now: d.now(),
      dataKey: d.keys.dataKey,
      ipSecret: d.ipSecret,
      power: parsePowerHeaders(req.headers),
    });
    return json(reply);
  });
}

export function failHandler(req: Request, d: Deps, fragmentId: string): Promise<Response> {
  return handle(async () => {
    const a = await agentAuth(req, d);
    if (a.error) return a.error;
    const input = await readJson(req, failInput, 1024);
    return json(await failFragment(d.db, a.node, { fragmentId, attempt: input.attempt, now: d.now(), ipSecret: d.ipSecret }));
  });
}

/** Public: the key agents pin to verify tasks. */
export function signingKeyHandler(d: Pick<Deps, "keys">): Response {
  return json({ alg: "Ed25519", kid: keyId(d.keys.publicKey), publicKeyPem: publicKeyPem(d.keys.publicKey) }, 200, {
    "Cache-Control": "public, max-age=300",
  });
}

// ─── Cron ──────────────────────────────────────────────────────────────────

export function cronTickHandler(req: Request, d: Deps): Promise<Response> {
  return handle(async () => {
    if (!isAuthorizedCron(req.headers.get("authorization"), d.cronSecret)) {
      return errorJson(401, "unauthorized", "Not allowed.");
    }
    return json({ report: await runTick(d.db, d.now(), d.ipSecret) });
  });
}
