import { deps } from "@/lib/api/deps";
import { heartbeatHandler } from "@/lib/api/handlers";

export async function POST(req: Request) {
  return heartbeatHandler(req, await deps());
}
