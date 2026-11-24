import { sql } from "drizzle-orm";
import { databaseIsolation, getDb } from "@/lib/db";
import { redisIsolation } from "@/lib/ratelimit";

/**
 * Uptime check. Reports up/down only, never error details. Down (503) also
 * when this deployment shares a Redis or database with the other environment
 * (lib/isolation.ts), or can't reach its Redis: CI checks this before it
 * promotes a production deployment, and after every preview deploy. The Redis
 * check is cached per instance (lib/ratelimit.ts), so calling this often costs
 * no Upstash commands.
 */
export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    const redis = await redisIsolation();
    if (!redis.ok || !databaseIsolation().ok) throw new Error("isolation");
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "degraded" }, { status: 503 });
  }
}
