import { deps } from "@/lib/api/deps";
import { leaseHandler } from "@/lib/api/handlers";

export async function POST(req: Request) {
  return leaseHandler(req, await deps());
}
