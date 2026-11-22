import { userDeps } from "@/lib/api/deps";
import { getJobHandler } from "@/lib/api/handlers";

export async function GET(req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  return getJobHandler(req, await userDeps(), (await ctx.params).id);
}
