import { deps } from "@/lib/api/deps";
import { leaseHandler } from "@/lib/api/handlers";
import { withServerTiming } from "@/lib/timing";

export async function POST(req: Request) {
  return withServerTiming(async () => leaseHandler(req, await deps()));
}
