import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AccountExport } from "@/lib/account";
import * as H from "@/lib/api/handlers";
import { auditLog, blobs, buyerLedger, jobs, nodes, ownerLedger, sessions, users } from "@/lib/db/schema";
import { freshDb } from "../helpers/db";
import { beat, body, complete, harness, jsonReq, lease, makeUser, ORIGIN, quoteTexts, registerNode, type Harness } from "../helpers/coordinator";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

let h: Harness;
beforeEach(async () => {
  const { db, cleanup } = await freshDb();
  cleanups.push(cleanup);
  h = harness(db);
});

type User = Awaited<ReturnType<typeof makeUser>>;

/** Owner with a PC that finished one piece of the buyer's job. */
async function world() {
  const owner = await makeUser(h.db, "owner@example.in");
  const buyer = await makeUser(h.db, "buyer@example.in");
  const pc = await registerNode(h, owner, { name: "Hostel PC" });
  await beat(h, pc.token, { watts: 400 });
  const q = await quoteTexts(h, buyer, 20);
  const { job } = await body<{ job: { id: string } }>(q);
  await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${job.id}/confirm`), h.as(buyer), job.id);
  await complete(h, pc.token, (await lease(h, pc.token))!);
  return { owner, buyer, pc, jobId: job.id };
}

const exportReq = (u: User | null) => H.exportAccountHandler(jsonReq("GET", "/api/account/export"), h.as(u));
const deleteReq = (u: User | null, b: unknown = { confirm: "DELETE" }, headers: Record<string, string> = {}) =>
  H.deleteAccountHandler(jsonReq("DELETE", "/api/account", b, headers), h.as(u));

describe("download your data (GET /api/account/export)", () => {
  it("returns everything about the account, and nothing about anyone else", async () => {
    const { owner, buyer, pc, jobId } = await world();

    const res = await exportReq(owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="nightshift-account-\d{4}-\d{2}-\d{2}\.json"$/);
    const data = await body<AccountExport>(res);
    expect(data.account).toMatchObject({ id: owner.id, email: "owner@example.in", role: "user" });
    expect(data.pcs.map((n) => n.id)).toEqual([pc.nodeId]);
    expect(data.jobs).toEqual([]);
    expect(data.ledgers.ownerEarnings.map((r) => r.entryType).sort()).toEqual(["compute_pay", "power_reimbursement"]);
    expect(data.activity.map((a) => a.action)).toContain("node.registered");
    const text = JSON.stringify(data);
    expect(text).not.toContain("buyer@example.in");
    expect(text).not.toContain("idempotencyKey");
    expect(text).not.toContain("ipHash");
    expect(text).not.toMatch(/token_?hash|nsn_/i);

    const forBuyer = await body<AccountExport>(await exportReq(buyer));
    expect(forBuyer.jobs.map((j) => j.id)).toEqual([jobId]);
    expect(forBuyer.ledgers.buyerPayments).toHaveLength(1);
    expect(forBuyer.pcs).toEqual([]);

    const logged = await h.db.select().from(auditLog).where(eq(auditLog.action, "account.exported"));
    expect(logged.map((a) => a.actorId).sort()).toEqual([owner.id, buyer.id].sort());
  });

  it("needs a session and is rate limited", async () => {
    const u = await makeUser(h.db, "a@example.in");
    expect((await exportReq(null)).status).toBe(401);
    h.limiter.deny.add("accountUser");
    expect((await exportReq(u)).status).toBe(429);
  });
});

describe("delete your account (DELETE /api/account)", () => {
  it("removes the email, logins, PC access and job data, and keeps the ledger without the email", async () => {
    const { owner, buyer, pc, jobId } = await world();
    await h.db.insert(sessions).values({ sessionToken: "s-owner", userId: owner.id, expires: new Date(Date.now() + 3600_000) });
    const ownerLedgerBefore = await h.db.select().from(ownerLedger).where(eq(ownerLedger.ownerId, owner.id));

    const res = await deleteReq(owner);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ deleted: true, pcsRemoved: 1, jobsPurged: 0 });
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Secure-authjs.session-token=;") && c.includes("Max-Age=0") && c.includes("Secure"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("authjs.session-token=;") && c.includes("Max-Age=0"))).toBe(true);

    const [row] = await h.db.select().from(users).where(eq(users.id, owner.id));
    expect(row!.email).toBeNull();
    expect(row!.deletedAt).not.toBeNull();
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, owner.id))).toEqual([]);
    // The PC's agent is locked out on its next request.
    expect((await beat(h, pc.token)).status).toBe(401);
    expect((await h.db.select().from(nodes).where(eq(nodes.id, pc.nodeId)))[0]!.status).toBe("revoked");
    // Money records stay, under the account id only.
    expect(await h.db.select().from(ownerLedger).where(eq(ownerLedger.ownerId, owner.id))).toHaveLength(ownerLedgerBefore.length);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "account.deleted")))[0]!.actorId).toBe(owner.id);

    // The buyer deletes too: their finished job's stored data goes now.
    expect((await h.db.select().from(blobs).where(eq(blobs.jobId, jobId))).length).toBeGreaterThan(0);
    const b = await deleteReq(buyer);
    expect(await body(b)).toMatchObject({ deleted: true, jobsPurged: 1, pcsRemoved: 0 });
    expect(await h.db.select().from(blobs).where(eq(blobs.jobId, jobId))).toEqual([]);
    expect((await h.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.purgedAt).not.toBeNull();
    expect(await h.db.select().from(buyerLedger).where(eq(buyerLedger.buyerId, buyer.id))).toHaveLength(1);

    // Gone is gone: no export, no second delete.
    expect((await exportReq(owner)).status).toBe(404);
    expect((await deleteReq(owner)).status).toBe(404);
  });

  it("waits while a job is still running, and cancels open quotes", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const pc = await registerNode(h, owner);
    await beat(h, pc.token);
    const quoted = (await body<{ job: { id: string } }>(await quoteTexts(h, buyer, 5))).job;
    const running = (await body<{ job: { id: string } }>(await quoteTexts(h, buyer, 5))).job;
    await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${running.id}/confirm`), h.as(buyer), running.id);

    const blocked = await deleteReq(buyer);
    expect(blocked.status).toBe(409);
    expect((await body(blocked)).error).toBe("jobs_running");
    expect((await h.db.select().from(users).where(eq(users.id, buyer.id)))[0]!.email).toBe("buyer@example.in");

    await h.db.update(jobs).set({ status: "completed", completedAt: h.clock.now() }).where(eq(jobs.id, running.id));
    expect((await deleteReq(buyer)).status).toBe(200);
    expect((await h.db.select().from(jobs).where(eq(jobs.id, quoted.id)))[0]!.status).toBe("cancelled");
  });

  it("needs the typed confirmation, a same-site request and a session", async () => {
    const u = await makeUser(h.db, "a@example.in");
    expect((await deleteReq(u, { confirm: "delete" })).status).toBe(400);
    expect((await deleteReq(u, {})).status).toBe(400);
    expect((await deleteReq(u, { confirm: "DELETE" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await deleteReq(null)).status).toBe(401);
    h.limiter.deny.add("accountUser");
    expect((await deleteReq(u)).status).toBe(429);
    expect((await h.db.select().from(users).where(eq(users.id, u.id)))[0]!.deletedAt).toBeNull();
    expect(ORIGIN).toMatch(/^https:/);
  });
});
