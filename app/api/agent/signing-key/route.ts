import { signingKeyHandler } from "@/lib/api/handlers";
import { getKeys } from "@/lib/security/keys";

export async function GET() {
  return signingKeyHandler({ keys: await getKeys() });
}
