import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { waitlist } from "@/lib/db/schema";
import { joinWaitlist, waitlistInput } from "@/lib/waitlist";
import { freshDb } from "../helpers/db";

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ db, cleanup } = await freshDb());
});
afterAll(async () => cleanup?.());

describe("waitlist input", () => {
  it("normalises email and requires consent", () => {
    expect(waitlistInput.parse({ email: "  Priya@Example.IN ", interest: "owner", consent: "on" }).email).toBe("priya@example.in");
    expect(waitlistInput.safeParse({ email: "a@b.in", interest: "owner" }).success).toBe(false);
    expect(waitlistInput.safeParse({ email: "a@b.in", interest: "owner", consent: "yes" }).success).toBe(false);
  });

  it("rejects bad emails, unknown interests and oversized input", () => {
    expect(waitlistInput.safeParse({ email: "not-an-email", interest: "owner", consent: "on" }).success).toBe(false);
    expect(waitlistInput.safeParse({ email: "a@b.in", interest: "admin", consent: "on" }).success).toBe(false);
    expect(waitlistInput.safeParse({ email: `${"a".repeat(250)}@b.in`, interest: "owner", consent: "on" }).success).toBe(false);
  });
});

describe("joinWaitlist", () => {
  it("stores the email with consent time, and a repeat signup is a silent no-op", async () => {
    const at = new Date("2026-11-22T10:00:00Z");
    await joinWaitlist(db, { email: "priya@example.in", interest: "owner", consent: "on" }, at);
    await expect(joinWaitlist(db, { email: "priya@example.in", interest: "buyer", consent: "on" })).resolves.toBeUndefined();
    const rows = await db.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "priya@example.in", interest: "owner", consentAt: at });
  });
});
