import { userDeps } from "@/lib/api/deps";
import { earningsHandler } from "@/lib/api/handlers";

export async function GET(req: Request) {
  return earningsHandler(req, await userDeps());
}
