import { deps } from "@/lib/api/deps";
import { heartbeatHandler } from "@/lib/api/handlers";
import { withServerTiming } from "@/lib/timing";

export async function POST(req: Request) {
  return withServerTiming(async () => heartbeatHandler(req, await deps()));
}
