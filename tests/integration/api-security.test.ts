import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import { MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES } from "@/lib/coordinator/workloads";
import type { Db } from "@/lib/db/client";
import { auditLog, jobs, nodes } from "@/lib/db/schema";
import { freshDb } from "../helpers/db";
import {
  agentReq,
  beat,
  body,
  complete,
  embeddingsFor,
  harness,
  jsonReq,
  lease,
  makeUser,
  ORIGIN,
  quoteTexts,
  registerNode,
  type Harness,
} from "../helpers/coordinator";
import { PNG_1PX } from "../helpers/fixtures";

let db: Db;
let cleanup: () => Promise<void>;
let h: Harness;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let aliceNode: { nodeId: string; token: string };
let bobNode: { nodeId: string; token: string };
let aliceJobId: string;
let aliceDoneJobId: string;

beforeAll(async () => {
  ({ db, cleanup } = await freshDb());
  h = harness(db);
  alice = await makeUser(db, "alice@example.in");
  bob = await makeUser(db, "bob@example.in");
  aliceNode = await registerNode(h, alice, { name: "Alice PC" });
  bobNode = await registerNode(h, bob, { name: "Bob PC" });
  await beat(h, aliceNode.token);
  await beat(h, bobNode.token);

  // Alice: one finished job (with results) and one open quote.
  const q1 = await body<{ job: { id: string } }>(await quoteTexts(h, alice, 10));
  aliceDoneJobId = q1.job.id;
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${aliceDoneJobId}/confirm`), h.as(alice), aliceDoneJobId);
  const l = (await lease(h, aliceNode.token)) ?? (await lease(h, bobNode.token));
  await complete(h, l!.parsed.nodeId === aliceNode.nodeId ? aliceNode.token : bobNode.token, l!);
  const q2 = await body<{ job: { id: string } }>(await quoteTexts(h, alice, 10));
  aliceJobId = q2.job.id;
});
afterAll(async () => cleanup?.());

describe("IDOR: user B can't read or change user A's things", () => {
  const notFound = async (res: Promise<Response>) => {
    const r = await res;
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("not_found");
  };

  it("jobs: read, confirm, cancel, results", async () => {
    await notFound(H.getJobHandler(jsonReq("GET", `/api/jobs/${aliceJobId}`), h.as(bob), aliceJobId));
    await notFound(H.confirmJobHandler(jsonReq("POST", `/api/jobs/${aliceJobId}/confirm`), h.as(bob), aliceJobId));
    await notFound(H.cancelJobHandler(jsonReq("POST", `/api/jobs/${aliceJobId}/cancel`), h.as(bob), aliceJobId));
    await notFound(H.resultsHandler(jsonReq("GET", `/api/jobs/${aliceDoneJobId}/results`), h.as(bob), aliceDoneJobId));
    const list = await body<{ jobs: Array<{ id: string }> }>(await H.listJobsHandler(jsonReq("GET", "/api/jobs"), h.as(bob)));
    expect(list.jobs.map((j) => j.id)).not.toContain(aliceJobId);
    // Alice's quote is untouched.
    const [row] = await db.select().from(jobs).where(eq(jobs.id, aliceJobId));
    expect(row!.status).toBe("quoted");
  });

  it("nodes: read, change settings, rotate or revoke the token", async () => {
    const id = aliceNode.nodeId;
    await notFound(H.getNodeHandler(jsonReq("GET", `/api/nodes/${id}`), h.as(bob), id));
    await notFound(H.updateNodeHandler(jsonReq("PATCH", `/api/nodes/${id}`, { ownerRatePaisePerHr: 1 }), h.as(bob), id));
    await notFound(H.rotateTokenHandler(jsonReq("POST", `/api/nodes/${id}/token`), h.as(bob), id));
    await notFound(H.revokeNodeHandler(jsonReq("DELETE", `/api/nodes/${id}/token`), h.as(bob), id));
    const list = await body<{ nodes: Array<{ id: string }> }>(await H.listNodesHandler(jsonReq("GET", "/api/nodes"), h.as(bob)));
    expect(list.nodes.map((n) => n.id)).toEqual([bobNode.nodeId]);
    const [row] = await db.select().from(nodes).where(eq(nodes.id, id));
    expect(row!.ownerRatePaisePerHr).toBe(2500);
    expect((await beat(h, aliceNode.token)).status).toBe(200); // token still works
  });

  it("earnings: each owner sees only their own", async () => {
    const a = await body<{ earnings: { balancePaise: number } }>(await H.earningsHandler(jsonReq("GET", "/api/earnings"), h.as(alice)));
    const b = await body<{ earnings: { balancePaise: number } }>(await H.earningsHandler(jsonReq("GET", "/api/earnings"), h.as(bob)));
    expect(a.earnings.balancePaise + b.earnings.balancePaise).toBeGreaterThan(0);
    expect(a.earnings.balancePaise === 0 || b.earnings.balancePaise === 0).toBe(true);
  });

  it("files: results only through the owner's own job, never by blob key", async () => {
    const r = await H.resultsHandler(jsonReq("GET", `/api/jobs/${aliceDoneJobId}/results`), h.as(alice), aliceDoneJobId);
    expect(r.status).toBe(200);
    await r.text();
  });

  it("agents: one node can't complete or fail another node's lease", async () => {
    const q = await body<{ job: { id: string } }>(await quoteTexts(h, bob, 10));
    await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.job.id}/confirm`), h.as(bob), q.job.id);
    await beat(h, bobNode.token);
    const l = (await lease(h, bobNode.token))!;
    const r = await complete(h, aliceNode.token, l);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("lease_lost");
    const f = await H.failHandler(
      jsonReq("POST", `/api/agent/fragments/${l.parsed.taskId}/fail`, { attempt: l.parsed.attempt, reason: "other" }, { authorization: `Bearer ${aliceNode.token}` }),
      h.deps,
      l.parsed.taskId,
    );
    expect(f.status).toBe(409);
    expect((await complete(h, bobNode.token, l)).status).toBe(200);
  });

  it("invoices: only for your own job", async () => {
    await notFound(H.invoiceHandler(jsonReq("GET", `/api/jobs/${aliceDoneJobId}/invoice`), h.as(bob), aliceDoneJobId));
    const own = await H.invoiceHandler(jsonReq("GET", `/api/jobs/${aliceDoneJobId}/invoice`), h.as(alice), aliceDoneJobId);
    expect(own.status).toBe(200);
    await own.arrayBuffer();
  });

  it("Time-Bank wallet, account export and payout UPI: always your own, whatever you send", async () => {
    // No endpoint takes an account id: each reads the session's.
    const credits = await body<{ history: Array<{ jobId: string | null }> }>(await H.creditsHandler(jsonReq("GET", `/api/credits?userId=${alice.id}`), h.as(bob)));
    expect(credits.history.every((r) => r.jobId === null || r.jobId !== aliceDoneJobId)).toBe(true);
    const exported = await body<{ account: { id: string; email: string } }>(await H.exportAccountHandler(jsonReq("GET", `/api/account/export?id=${alice.id}`), h.as(bob)));
    expect(exported.account).toMatchObject({ id: bob.id, email: "bob@example.in" });
    expect(JSON.stringify(exported)).not.toContain("alice@example.in");
    await H.linkUpiHandler(jsonReq("POST", "/api/account/upi", { upiId: "alice@okaxis" }), h.as(alice));
    const taken = await H.linkUpiHandler(jsonReq("POST", "/api/account/upi", { upiId: "alice@okaxis" }), h.as(bob));
    expect(taken.status).toBe(409);
  });

  it("paying with credits only ever spends your own", async () => {
    const q = await body<{ job: { id: string } }>(await quoteTexts(h, bob, 5));
    const r = await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.job.id}/confirm`, { payWith: "credits" }), h.as(bob), q.job.id);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("not_enough_credits");
  });

  it("ids that aren't UUIDs are just 'not found'", async () => {
    await notFound(H.getJobHandler(jsonReq("GET", "/api/jobs/1 or 1=1"), h.as(alice), "1 or 1=1"));
    await notFound(H.getNodeHandler(jsonReq("GET", "/api/nodes/../x"), h.as(alice), "../x"));
  });
});

describe("missing or expired session", () => {
  it("every buyer and owner endpoint answers 401 without a session", async () => {
    const anon = h.as(null);
    const id = aliceJobId;
    const nid = aliceNode.nodeId;
    const calls: Array<Promise<Response>> = [
      H.quoteHandler(jsonReq("POST", "/api/jobs/quote", {}), anon),
      H.listJobsHandler(jsonReq("GET", "/api/jobs"), anon),
      H.getJobHandler(jsonReq("GET", `/api/jobs/${id}`), anon, id),
      H.confirmJobHandler(jsonReq("POST", `/api/jobs/${id}/confirm`), anon, id),
      H.cancelJobHandler(jsonReq("POST", `/api/jobs/${id}/cancel`), anon, id),
      H.resultsHandler(jsonReq("GET", `/api/jobs/${id}/results`), anon, id),
      H.registerNodeHandler(jsonReq("POST", "/api/nodes", { name: "x", gpuClass: "cpu" }), anon),
      H.listNodesHandler(jsonReq("GET", "/api/nodes"), anon),
      H.getNodeHandler(jsonReq("GET", `/api/nodes/${nid}`), anon, nid),
      H.updateNodeHandler(jsonReq("PATCH", `/api/nodes/${nid}`, { paused: true }), anon, nid),
      H.rotateTokenHandler(jsonReq("POST", `/api/nodes/${nid}/token`), anon, nid),
      H.revokeNodeHandler(jsonReq("DELETE", `/api/nodes/${nid}/token`), anon, nid),
      H.earningsHandler(jsonReq("GET", "/api/earnings"), anon),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(401);
      expect((await r.json()).error).toBe("unauthenticated");
    }
  });
});

describe("CSRF: cookie-authenticated writes need our own Origin", () => {
  it("refuses cross-site and Origin-less writes", async () => {
    const evil = jsonReq("POST", "/api/nodes", { name: "x", gpuClass: "cpu" }, { origin: "https://evil.example" });
    expect((await H.registerNodeHandler(evil, h.as(alice))).status).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/api/jobs/${aliceJobId}/confirm`, { method: "POST" });
    expect((await H.confirmJobHandler(noOrigin, h.as(alice), aliceJobId)).status).toBe(403);
    const sameSite = new Request(`${ORIGIN}/api/nodes`, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
    expect((await H.listNodesHandler(sameSite, h.as(alice))).status).toBe(200);
  });
});

describe("oversized and malformed payloads", () => {
  it("refuses a body over the limit by Content-Length, before reading it", async () => {
    const req = jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass: "rtx4070", texts: ["a"] }, { "content-length": String(MAX_REQUEST_BYTES + 1) });
    const r = await H.quoteHandler(req, h.as(alice));
    expect(r.status).toBe(413);
  });

  it("refuses a body over the limit while streaming, when Content-Length lies or is absent", async () => {
    const big = "x".repeat(MAX_REQUEST_BYTES + 10);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`{"workloadType":"text_embeddings","gpuClass":"rtx4070","texts":["${big}"]}`));
        c.close();
      },
    });
    const req = new Request(`${ORIGIN}/api/jobs/quote`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: stream,
      // @ts-expect-error Node needs this for a streamed request body.
      duplex: "half",
    });
    expect((await H.quoteHandler(req, h.as(alice))).status).toBe(413);
  });

  it("refuses an agent output over 4 MB", async () => {
    const r = await H.completeHandler(
      new Request(`${ORIGIN}/api/agent/fragments/00000000-0000-4000-8000-000000000000/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${aliceNode.token}`, "content-type": "application/json", "x-lease-attempt": "1", "content-length": String(MAX_OUTPUT_BYTES + 1) },
        body: "{}",
      }),
      h.deps,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(r.status).toBe(413);
  });

  it("too many texts, unknown fields, bad JSON and wrong content types", async () => {
    const tooMany = await quoteTexts(h, alice, 5001);
    expect(tooMany.status).toBe(400);
    const extra = await H.quoteHandler(
      jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass: "rtx4070", texts: ["a"], script: "rm -rf /" }),
      h.as(alice),
    );
    expect(extra.status).toBe(400);
    const badParam = await H.quoteHandler(
      jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass: "rtx4070", texts: ["a"], params: { model: "../../etc/passwd" } }),
      h.as(alice),
    );
    expect(badParam.status).toBe(400);
    expect((await badParam.json()).error).toBe("bad_params");
    const notJson = new Request(`${ORIGIN}/api/nodes`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{nope" });
    expect((await H.registerNodeHandler(notJson, h.as(alice))).status).toBe(400);
    const form = new Request(`${ORIGIN}/api/nodes`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "x" });
    expect((await H.registerNodeHandler(form, h.as(alice))).status).toBe(415);
  });

  it("validation errors name fields, never echo values", async () => {
    const r = await H.registerNodeHandler(jsonReq("POST", "/api/nodes", { name: "<script>alert(1)</script>", gpuClass: "quantum" }), h.as(alice));
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("quantum");
    expect(JSON.parse(text).fields).toEqual(expect.arrayContaining(["name", "gpuClass"]));
  });

  it("an agent output that doesn't match its sha256 is refused", async () => {
    const q = await body<{ job: { id: string } }>(await quoteTexts(h, alice, 10));
    await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${q.job.id}/confirm`), h.as(alice), q.job.id);
    await beat(h, aliceNode.token);
    const l = (await lease(h, aliceNode.token))!;
    const out = embeddingsFor(l);
    const r = await complete(h, aliceNode.token, l, out, createHash("sha256").update("other").digest("hex"));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("digest_mismatch");
    // Invalid output (wrong number of items) counts as a failed attempt.
    const bad = Buffer.from(JSON.stringify({ items: [[1, 2, 3]] }));
    const r2 = await complete(h, aliceNode.token, l, bad);
    expect(r2.status).toBe(422);
  });
});

describe("banned file types in image jobs", () => {
  const upload = (files: Array<[string, Buffer, string]>) => {
    const form = new FormData();
    form.set("request", JSON.stringify({ workloadType: "image_resize", gpuClass: "rtx4070", params: { width: 64, height: 64 } }));
    for (const [name, data, type] of files) form.append("images", new Blob([new Uint8Array(data)], { type }), name);
    return new Request(`${ORIGIN}/api/jobs/quote`, { method: "POST", headers: { origin: ORIGIN }, body: form });
  };

  it.each([
    ["an SVG named .png", "cat.png", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "image/png"],
    ["HTML", "page.jpg", Buffer.from("<!doctype html><script>alert(1)</script>"), "image/jpeg"],
    ["a Windows executable", "photo.webp", Buffer.from("MZ\x90\x00\x03\x00\x00\x00"), "image/webp"],
    ["a GIF", "anim.gif", Buffer.from("GIF89a\x01\x00\x01\x00"), "image/gif"],
  ])("refuses %s, whatever its name and declared type", async (_label, name, data, type) => {
    const r = await H.quoteHandler(upload([[name, data, type]]), h.as(alice));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("bad_file_type");
  });

  it("accepts a real PNG (when a PC is available)", async () => {
    await beat(h, aliceNode.token);
    const r = await H.quoteHandler(upload([["../../etc/passwd.png", PNG_1PX, "application/octet-stream"]]), h.as(bob));
    expect(r.status).toBe(201);
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After on every limited surface", async () => {
    const cases: Array<[Parameters<typeof h.limiter.deny.add>[0], () => Promise<Response>]> = [
      ["quoteUser", () => quoteTexts(h, alice, 1)],
      ["jobSubmitUser", () => H.confirmJobHandler(jsonReq("POST", `/api/jobs/${aliceJobId}/confirm`), h.as(alice), aliceJobId)],
      ["nodeManageUser", () => H.registerNodeHandler(jsonReq("POST", "/api/nodes", { name: "x", gpuClass: "cpu" }), h.as(alice))],
      ["agentIp", () => beat(h, aliceNode.token)],
      ["agentNode", () => H.leaseHandler(agentReq(aliceNode.token, "/api/agent/lease"), h.deps)],
    ];
    for (const [policy, call] of cases) {
      h.limiter.deny.add(policy);
      const r = await call();
      h.limiter.deny.delete(policy);
      expect(r.status, policy).toBe(429);
      expect(Number(r.headers.get("retry-after")), policy).toBeGreaterThan(0);
    }
  });

  it("limits agents per IP and per token before looking up the token", async () => {
    h.limiter.calls = [];
    h.limiter.deny.add("agentIp");
    // An unknown token: if the lookup ran first, this would be a 401, not a 429.
    const r = await beat(h, "nsn_" + "A".repeat(43));
    h.limiter.deny.delete("agentIp");
    expect(r.status).toBe(429);
    expect(h.limiter.calls.map((c) => c[0]).sort()).toEqual(["agentIp", "agentNode"]);
    // The per-token key is the token's hash, never the token itself.
    expect(h.limiter.calls.find((c) => c[0] === "agentNode")?.[1]).toMatch(/^token:[0-9a-f]{64}$/);
  });
});

describe("agent tokens", () => {
  it("refuses missing, malformed, unknown and revoked tokens", async () => {
    const statuses = await Promise.all([
      H.heartbeatHandler(new Request(`${ORIGIN}/api/agent/heartbeat`, { method: "POST", body: "{}" }), h.deps),
      beat(h, "not-a-token"),
      beat(h, "nsn_" + "B".repeat(43)),
      beat(h, aliceNode.token.slice(0, -1) + (aliceNode.token.endsWith("A") ? "B" : "A")),
    ]);
    for (const r of statuses) expect(r.status).toBe(401);

    const fresh = await registerNode(h, alice, { name: "Spare" });
    await H.revokeNodeHandler(jsonReq("DELETE", `/api/nodes/${fresh.nodeId}/token`), h.as(alice), fresh.nodeId);
    expect((await beat(h, fresh.token)).status).toBe(401);
  });

  it("a quarantined PC gets no work", async () => {
    const q = await registerNode(h, alice, { name: "Suspect" });
    await beat(h, q.token);
    await db.update(nodes).set({ status: "quarantined" }).where(eq(nodes.id, q.nodeId));
    const r = await H.leaseHandler(agentReq(q.token, "/api/agent/lease"), h.deps);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("quarantined");
  });

  it("the token is shown once and only its hash is stored", async () => {
    const r = await H.registerNodeHandler(jsonReq("POST", "/api/nodes", { name: "Hash check", gpuClass: "cpu" }), h.as(alice));
    const { token, node } = await body<{ token: string; node: { id: string } }>(r);
    const got = await body(await H.getNodeHandler(jsonReq("GET", `/api/nodes/${node.id}`), h.as(alice), node.id));
    expect(JSON.stringify(got)).not.toContain(token);
    const dump = JSON.stringify(await db.select().from(nodes)) + JSON.stringify(await db.select().from(auditLog));
    expect(dump).not.toContain(token);
  });

  it("token creation and revocation are audited", async () => {
    const actions = (await db.select({ a: auditLog.action }).from(auditLog)).map((r) => r.a);
    expect(actions).toContain("node.token_created");
    expect(actions).toContain("node.token_revoked");
    expect(actions).toContain("job.confirmed");
  });
});

describe("public signing key", () => {
  it("publishes the Ed25519 public key (and never the private key)", async () => {
    const r = H.signingKeyHandler(h.deps);
    const b = await body<{ alg: string; kid: string; publicKeyPem: string }>(r);
    expect(b.alg).toBe("Ed25519");
    expect(b.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(JSON.stringify(b)).not.toMatch(/PRIVATE/);
  });
});
