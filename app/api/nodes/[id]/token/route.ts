import { userDeps } from "@/lib/api/deps";
import { revokeNodeHandler, rotateTokenHandler } from "@/lib/api/handlers";

/** Issue a new token (the old one stops working). Shown once. */
export async function POST(req: Request, ctx: RouteContext<"/api/nodes/[id]/token">) {
  return rotateTokenHandler(req, await userDeps(), (await ctx.params).id);
}

/** Revoke every token: the agent is locked out. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/nodes/[id]/token">) {
  return revokeNodeHandler(req, await userDeps(), (await ctx.params).id);
}
