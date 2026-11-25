import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminAudit, adminJobs, adminLedger, adminNodes, adminTotals } from "@/lib/admin";
import * as H from "@/lib/api/handlers";
import { runTick } from "@/lib/coordinator/tick";
import { creditBalance, earningsByNode, ownerLedgerEntries, ownerPieces } from "@/lib/dashboard";
import { creditLedger, nodes } from "@/lib/db/schema";
import { freshDb } from "../helpers/db";
import { beat, body, complete, harness, jsonReq, lease, makeUser, quoteTexts, registerNode, type Harness } from "../helpers/coordinator";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

let h: Harness;
beforeEach(async () => {
  const { db, cleanup } = await freshDb();
  cleanups.push(cleanup);
  h = harness(db);
});

async function confirmed(buyer: Awaited<ReturnType<typeof makeUser>>, n = 20) {
  const q = await quoteTexts(h, buyer, n);
  expect(q.status).toBe(201);
  const { job } = await body<{ job: { id: string; pricePaise: number } }>(q);
  expect((await H.confirmJobHandler(jsonReq("POST", `/api/jobs/${job.id}/confirm`), h.as(buyer), job.id)).status).toBe(200);
  return job;
}

const invoice = (user: Awaited<ReturnType<typeof makeUser>> | null, id: string) => H.invoiceHandler(jsonReq("GET", `/api/jobs/${id}/invoice`), h.as(user), id);
const pdfText = async (res: Response) => Buffer.from(await res.arrayBuffer()).toString("latin1");

describe("invoices (GET /api/jobs/:id/invoice)", () => {
  it("gives the buyer a PDF of a finished job, as a download", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const pc = await registerNode(h, owner);
    await beat(h, pc.token, { watts: 400 });
    const job = await confirmed(buyer);
    const l = (await lease(h, pc.token))!;
    expect((await complete(h, pc.token, l)).status).toBe(200);

    const res = await invoice(buyer, job.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="nightshift-invoice-NS-[0-9A-F]{8}\.pdf"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const pdf = await pdfText(res);
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("buyer@example.in");
    expect(pdf).toContain("Finished, finished");
    expect(pdf).toContain("Total paid");
    expect(pdf).not.toContain("Refund,");
  });

  it("adds the refund line automatically when the deadline is missed", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const pc = await registerNode(h, owner);
    await beat(h, pc.token);
    const job = await confirmed(buyer);
    // Nobody runs it; the deadline passes and the tick refunds in full.
    h.clock.advance(24 * 3600);
    await runTick(h.db, h.clock.now(), "test-ip-secret");

    const pdf = await pdfText(await invoice(buyer, job.id));
    expect(pdf).toMatch(/Refund, [^)]*Deadline missed: full refund/);
    expect(pdf).toContain(`-Rs. ${(job.pricePaise / 100).toFixed(2)}`);
    expect(pdf).toContain("Rs. 0.00");
  });

  it("refuses other buyers (404), signed-out visitors (401), bad ids (404) and unconfirmed quotes (409)", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const other = await makeUser(h.db, "other@example.in");
    const pc = await registerNode(h, owner);
    await beat(h, pc.token);
    const job = await confirmed(buyer);

    expect((await invoice(other, job.id)).status).toBe(404);
    expect((await invoice(null, job.id)).status).toBe(401);
    expect((await invoice(buyer, "not-a-uuid")).status).toBe(404);

    const q = await quoteTexts(h, buyer, 5);
    const quoted = (await body<{ job: { id: string } }>(q)).job;
    const res = await invoice(buyer, quoted.id);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("no_invoice");
  });
});

describe("owner dashboard queries", () => {
  it("shows per-PC earnings with electricity separate, scoped to the owner", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const stranger = await makeUser(h.db, "stranger@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const pc = await registerNode(h, owner);
    await beat(h, pc.token, { watts: 400 });
    await confirmed(buyer);
    const l = (await lease(h, pc.token))!;
    await complete(h, pc.token, l);

    const per = await earningsByNode(h.db, owner.id);
    expect(per).toHaveLength(1);
    expect(per[0]!.nodeId).toBe(pc.nodeId);
    expect(per[0]!.pieces).toBe(1);
    expect(per[0]!.computePayPaise).toBeGreaterThan(0);
    expect(per[0]!.powerReimbursementPaise).toBeGreaterThan(0);

    const entries = await ownerLedgerEntries(h.db, owner.id);
    expect(entries.map((e) => e.type).sort()).toEqual(["compute_pay", "power_reimbursement"]);
    expect(entries.every((e) => e.nodeId === pc.nodeId)).toBe(true);
    expect(await ownerLedgerEntries(h.db, owner.id, 1)).toHaveLength(1);

    const pieces = await ownerPieces(h.db, owner.id);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ fragmentId: l.parsed.taskId, nodeId: pc.nodeId, computePayPaise: per[0]!.computePayPaise, powerReimbursementPaise: per[0]!.powerReimbursementPaise });
    expect(pieces[0]!.at).toBeInstanceOf(Date);
    expect(await ownerPieces(h.db, stranger.id)).toEqual([]);

    expect(await earningsByNode(h.db, stranger.id)).toEqual([]);
    expect(await ownerLedgerEntries(h.db, stranger.id)).toEqual([]);
  });

  it("sums Time-Bank credits per user", async () => {
    const a = await makeUser(h.db, "a@example.in");
    const b = await makeUser(h.db, "b@example.in");
    expect(await creditBalance(h.db, a.id)).toBe(0);
    await h.db.insert(creditLedger).values([
      { userId: a.id, entryType: "earned", amountGpuSeconds: 7200, idempotencyKey: "t1" },
      { userId: a.id, entryType: "spent", amountGpuSeconds: -1800, idempotencyKey: "t2" },
      { userId: b.id, entryType: "earned", amountGpuSeconds: 99, idempotencyKey: "t3" },
    ]);
    expect(await creditBalance(h.db, a.id)).toBe(5400);
  });
});

describe("admin panel queries", () => {
  it("lists nodes, quarantine, jobs, all three ledgers and the audit log", async () => {
    const owner = await makeUser(h.db, "owner@example.in");
    const buyer = await makeUser(h.db, "buyer@example.in");
    const pc = await registerNode(h, owner, { name: "Lab PC" });
    const bad = await registerNode(h, owner, { name: "Bad PC" });
    await h.db.update(nodes).set({ status: "quarantined", quarantinedAt: h.clock.now() }).where(eq(nodes.id, bad.nodeId));
    await beat(h, pc.token, { watts: 400 });
    const job = await confirmed(buyer);
    await complete(h, pc.token, (await lease(h, pc.token))!);
    await h.db.insert(creditLedger).values({ userId: owner.id, entryType: "earned", amountGpuSeconds: 60, idempotencyKey: "c1" });

    const totals = await adminTotals(h.db);
    expect(totals).toMatchObject({ users: 2, nodes: 2, jobs: 1, buyerNetPaise: job.pricePaise });
    expect(totals.ownerNetPaise).toBeGreaterThan(0);

    expect((await adminNodes(h.db)).map((n) => n.name).sort()).toEqual(["Bad PC", "Lab PC"]);
    const q = await adminNodes(h.db, true);
    expect(q.map((n) => n.name)).toEqual(["Bad PC"]);
    // No contact data in admin rows.
    expect(JSON.stringify(q)).not.toContain("@");

    const js = await adminJobs(h.db);
    expect(js.map((j) => j.id)).toEqual([job.id]);
    expect(js[0]!.status).toBe("completed");

    const ledger = await adminLedger(h.db);
    expect(new Set(ledger.map((r) => r.ledger))).toEqual(new Set(["owner", "buyer", "credit"]));
    expect(ledger.find((r) => r.ledger === "credit")).toMatchObject({ unit: "gpu_seconds", amount: 60 });
    const times = ledger.map((r) => r.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const actions = (await adminAudit(h.db)).map((a) => a.action);
    expect(actions).toContain("node.registered");
    expect(actions).toContain("job.confirmed");
  });
});
