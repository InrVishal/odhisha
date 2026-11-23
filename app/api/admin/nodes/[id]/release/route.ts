import { userDeps } from "@/lib/api/deps";
import { releaseNodeHandler } from "@/lib/api/handlers";

/** Admin only: release a quarantined PC. */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/nodes/[id]/release">) {
  return releaseNodeHandler(req, await userDeps(), (await ctx.params).id);
}
