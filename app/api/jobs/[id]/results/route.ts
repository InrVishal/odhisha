import { userDeps } from "@/lib/api/deps";
import { resultsHandler } from "@/lib/api/handlers";

export async function GET(req: Request, ctx: RouteContext<"/api/jobs/[id]/results">) {
  return resultsHandler(req, await userDeps(), (await ctx.params).id);
}
