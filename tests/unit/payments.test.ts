import { describe, expect, it } from "vitest";
import { DemoPayments, getPayments, setPaymentsForTests } from "@/lib/payments";

describe("payments (demo mode)", () => {
  const p = new DemoPayments();

  it("simulates charges, refunds and payouts, marked as demo", async () => {
    const c = await p.charge({ buyerId: "b", jobId: "j", amountPaise: 55200, idempotencyKey: "charge:j" });
    const r = await p.refund({ buyerId: "b", jobId: "j", amountPaise: 55200, reason: "deadline_missed", idempotencyKey: "refund:j" });
    const o = await p.payout({ ownerId: "o", amountPaise: 1000, idempotencyKey: "po:1" });
    for (const res of [c, r, o]) {
      expect(res.ok).toBe(true);
      expect(res.demo).toBe(true);
      expect(res.reference).toMatch(/^demo_/);
    }
  });

  it("is idempotent: the same key gives the same reference", async () => {
    const a = await p.charge({ buyerId: "b", jobId: "j", amountPaise: 100, idempotencyKey: "k" });
    const b = await p.charge({ buyerId: "b", jobId: "j", amountPaise: 100, idempotencyKey: "k" });
    expect(a.reference).toBe(b.reference);
  });

  it("refuses negative or fractional amounts", async () => {
    await expect(p.charge({ buyerId: "b", jobId: "j", amountPaise: -1, idempotencyKey: "x" })).rejects.toThrow();
    await expect(p.payout({ ownerId: "o", amountPaise: 1.5, idempotencyKey: "y" })).rejects.toThrow();
  });

  it("can be swapped for another provider behind the same interface", () => {
    const original = getPayments();
    const fake = new DemoPayments();
    setPaymentsForTests(fake);
    expect(getPayments()).toBe(fake);
    setPaymentsForTests(original);
    expect(getPayments().name).toBe("demo");
  });
});
