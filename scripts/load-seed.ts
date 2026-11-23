/**
 * Seeds a LOCAL load-test database (never a real one): N accounts, each
 * with a login session and one CPU-class PC that is online, measured and
 * available all day. Writes what each k6 virtual user needs to a JSON file.
 *
 *   DATABASE_URL=postgres://...localhost... npx tsx scripts/load-seed.ts 200 load-seed.json
 *
 * Refuses anything but localhost, so it can't touch preview or production.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createDb } from "../lib/db/client";
import { nodes, nodeTokens, sessions, users } from "../lib/db/schema";
import { generateNodeToken, hashToken } from "../lib/security/tokens";

async function main() {
  const n = Number(process.argv[2] ?? 200);
  const out = process.argv[3] ?? "load-seed.json";
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (!["localhost", "127.0.0.1"].includes(host)) throw new Error("load-seed only seeds a local database");
  const { db, close } = await createDb(url);
  const vus = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const [u] = await db.insert(users).values({ email: `load-${i}@nightshift.invalid`, emailVerified: now }).returning();
    const sessionToken = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ sessionToken, userId: u!.id, expires: new Date(now.getTime() + 6 * 3600_000) });
    const [node] = await db
      .insert(nodes)
      .values({
        ownerId: u!.id,
        name: `Load PC ${i}`,
        gpuClass: "cpu",
        defaultWatts: 65,
        status: "online",
        benchmarkScore: 1000,
        lastCanaryAt: now,
        lastSeenAt: now,
        nightWindowStartMin: 0,
        nightWindowEndMin: 0,
        // Already past the "new PC" stage, as most agents in a busy network are.
        piecesDone: 50,
        trustScore: 900,
      })
      .returning();
    const token = generateNodeToken();
    await db.insert(nodeTokens).values({ nodeId: node!.id, tokenHash: hashToken(token) });
    // One /24 per virtual user, so the network rule treats them as different places.
    vus.push({ cookie: `authjs.session-token=${sessionToken}`, token, ip: `10.${Math.floor(i / 250) + 1}.${i % 250}.7`, deviceId: randomBytes(32).toString("hex") });
  }
  await close();
  writeFileSync(out, JSON.stringify(vus));
  console.log(`load-seed: ${n} accounts, sessions and PCs written to ${out}`);
}

main().catch((e: unknown) => {
  console.error("load-seed failed:", e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, "<url>") : "unknown error");
  process.exit(1);
});
