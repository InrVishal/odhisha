import { deps } from "@/lib/api/deps";
import { cronTickHandler } from "@/lib/api/handlers";

/** Vercel Cron calls this with Authorization: Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  return cronTickHandler(req, await deps());
}
