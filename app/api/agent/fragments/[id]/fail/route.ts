import { deps } from "@/lib/api/deps";
import { failHandler } from "@/lib/api/handlers";

export async function POST(req: Request, ctx: RouteContext<"/api/agent/fragments/[id]/fail">) {
  return failHandler(req, await deps(), (await ctx.params).id);
}
