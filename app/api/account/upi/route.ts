import { userDeps } from "@/lib/api/deps";
import { linkUpiHandler } from "@/lib/api/handlers";

export async function POST(req: Request) {
  return linkUpiHandler(req, await userDeps());
}
