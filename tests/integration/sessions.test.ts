import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revokeAllSessions } from "@/lib/auth/sessions";
import type { Db } from "@/lib/db/client";
import { sessions, users } from "@/lib/db/schema";
import { freshDb } from "../helpers/db";

let db: Db;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ db, cleanup } = await freshDb());
});
afterAll(async () => cleanup?.());

describe("log out of all devices", () => {
  it("revokes every session of that user and no one else's", async () => {
    const [a] = await db.insert(users).values({ email: "a@example.in" }).returning();
    const [b] = await db.insert(users).values({ email: "b@example.in" }).returning();
    const expires = new Date(Date.now() + 86_400_000);
    await db.insert(sessions).values([
      { sessionToken: "a-laptop", userId: a!.id, expires },
      { sessionToken: "a-phone", userId: a!.id, expires },
      { sessionToken: "a-cafe-pc", userId: a!.id, expires },
      { sessionToken: "b-laptop", userId: b!.id, expires },
    ]);

    expect(await revokeAllSessions(db, a!.id)).toBe(3);
    expect(await db.select().from(sessions).where(eq(sessions.userId, a!.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, b!.id))).toHaveLength(1);
    expect(await revokeAllSessions(db, a!.id)).toBe(0);
  });
});
