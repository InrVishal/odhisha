import { userDeps } from "@/lib/api/deps";
import { cancelJobHandler } from "@/lib/api/handlers";

export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/cancel">) {
  return cancelJobHandler(req, await userDeps(), (await ctx.params).id);
}
