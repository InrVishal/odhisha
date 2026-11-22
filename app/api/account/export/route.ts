import { userDeps } from "@/lib/api/deps";
import { exportAccountHandler } from "@/lib/api/handlers";

/** Everything we store about the signed-in account, as a JSON download. */
export async function GET(req: Request) {
  return exportAccountHandler(req, await userDeps());
}
