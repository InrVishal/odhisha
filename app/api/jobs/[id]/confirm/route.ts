import { userDeps } from "@/lib/api/deps";
import { confirmJobHandler } from "@/lib/api/handlers";

export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/confirm">) {
  return confirmJobHandler(req, await userDeps(), (await ctx.params).id);
}
