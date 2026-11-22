import { userDeps } from "@/lib/api/deps";
import { listNodesHandler, registerNodeHandler } from "@/lib/api/handlers";

export async function GET(req: Request) {
  return listNodesHandler(req, await userDeps());
}

export async function POST(req: Request) {
  return registerNodeHandler(req, await userDeps());
}
