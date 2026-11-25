import { userDeps } from "@/lib/api/deps";
import { adminNotFoundHandler, releaseNodeHandler } from "@/lib/api/handlers";

/** Admin only: release a quarantined PC. Everyone else gets a 404, whatever the method. */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/nodes/[id]/release">) {
  return releaseNodeHandler(req, await userDeps(), (await ctx.params).id);
}

export const GET = adminNotFoundHandler;
export const PUT = adminNotFoundHandler;
export const PATCH = adminNotFoundHandler;
export const DELETE = adminNotFoundHandler;
