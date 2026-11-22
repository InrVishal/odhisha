import { userDeps } from "@/lib/api/deps";
import { listJobsHandler } from "@/lib/api/handlers";

export async function GET(req: Request) {
  return listJobsHandler(req, await userDeps());
}
