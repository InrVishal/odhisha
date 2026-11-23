import { userDeps } from "@/lib/api/deps";
import { creditsHandler } from "@/lib/api/handlers";

export async function GET(req: Request) {
  return creditsHandler(req, await userDeps());
}
