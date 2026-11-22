import { userDeps } from "@/lib/api/deps";
import { deleteAccountHandler } from "@/lib/api/handlers";

/** Deletes the signed-in account. Body: {"confirm": "DELETE"}. */
export async function DELETE(req: Request) {
  return deleteAccountHandler(req, await userDeps());
}
