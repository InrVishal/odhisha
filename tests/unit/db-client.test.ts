import { describe, expect, it } from "vitest";
import { createDb } from "@/lib/db/client";

// Pools connect lazily, so these check driver selection without a network.
describe("createDb driver selection", () => {
  it("uses the Neon serverless driver for *.neon.tech", async () => {
    const h = await createDb("postgresql://u:p@ep-cool-1.ap-southeast-1.aws.neon.tech/db?sslmode=require");
    expect(h.driver).toBe("neon");
    await h.close();
  });

  it("uses node-postgres for any other postgres URL", async () => {
    const h = await createDb("postgres://u:p@127.0.0.1:1/db");
    expect(h.driver).toBe("pg");
    await h.close();
  });

  it("treats an unparseable URL as non-Neon", async () => {
    const h = await createDb("postgres://%%bad");
    expect(h.driver).toBe("pg");
    await h.close();
  });

  // PGlite is exercised by every integration test.
});
