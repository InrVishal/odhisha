import { userDeps } from "@/lib/api/deps";
import { confirmJobHandler } from "@/lib/api/handlers";
import { withServerTiming } from "@/lib/timing";

export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/confirm">) {
  return withServerTiming(async () => confirmJobHandler(req, await userDeps(), (await ctx.params).id));
}
