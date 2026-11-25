import { deps } from "@/lib/api/deps";
import { completeHandler } from "@/lib/api/handlers";
import { withServerTiming } from "@/lib/timing";

export async function POST(req: Request, ctx: RouteContext<"/api/agent/fragments/[id]/complete">) {
  return withServerTiming(async () => completeHandler(req, await deps(), (await ctx.params).id));
}
