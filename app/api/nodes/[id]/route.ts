import { userDeps } from "@/lib/api/deps";
import { getNodeHandler, updateNodeHandler } from "@/lib/api/handlers";

export async function GET(req: Request, ctx: RouteContext<"/api/nodes/[id]">) {
  return getNodeHandler(req, await userDeps(), (await ctx.params).id);
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/nodes/[id]">) {
  return updateNodeHandler(req, await userDeps(), (await ctx.params).id);
}
