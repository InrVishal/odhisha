import { userDeps } from "@/lib/api/deps";
import { quoteHandler } from "@/lib/api/handlers";
import { withServerTiming } from "@/lib/timing";

export async function POST(req: Request) {
  return withServerTiming(async () => quoteHandler(req, await userDeps()));
}
