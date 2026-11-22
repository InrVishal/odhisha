import { deps } from "@/lib/api/deps";
import { completeHandler } from "@/lib/api/handlers";

export async function POST(req: Request, ctx: RouteContext<"/api/agent/fragments/[id]/complete">) {
  return completeHandler(req, await deps(), (await ctx.params).id);
}
