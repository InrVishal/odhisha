import { signOut } from "@/lib/auth";
import { requireUserOrRedirect } from "@/lib/auth/guards";
import { logoutEverywhere } from "./actions";

// Placeholder. Phase 5 builds the buyer, owner and admin dashboards.
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();

  async function logout() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-4 py-24">
      <h1 className="text-2xl font-semibold">You&apos;re logged in</h1>
      <p>
        Account type: {user.role === "admin" ? "admin" : "regular"}. Dashboards come in a later phase.
      </p>
      <div className="flex flex-wrap gap-3">
        <form action={logout}>
          <button type="submit" className="rounded border border-zinc-400 px-4 py-2">
            Log out
          </button>
        </form>
        <form action={logoutEverywhere}>
          <button type="submit" className="rounded border border-zinc-400 px-4 py-2">
            Log out of all devices
          </button>
        </form>
      </div>
      <p className="text-sm">Lost a phone or used a cyber café PC? &quot;Log out of all devices&quot; ends every login on this account.</p>
    </main>
  );
}
