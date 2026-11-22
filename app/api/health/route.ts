import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

/** Uptime check. Reports up/down only, never error details. */
export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "degraded" }, { status: 503 });
  }
}
