import { userDeps } from "@/lib/api/deps";
import { invoiceHandler } from "@/lib/api/handlers";

export async function GET(req: Request, ctx: RouteContext<"/api/jobs/[id]/invoice">) {
  return invoiceHandler(req, await userDeps(), (await ctx.params).id);
}
