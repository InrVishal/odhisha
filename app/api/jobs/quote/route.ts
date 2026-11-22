import { userDeps } from "@/lib/api/deps";
import { quoteHandler } from "@/lib/api/handlers";

export async function POST(req: Request) {
  return quoteHandler(req, await userDeps());
}
