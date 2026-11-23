import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav, type NavItem } from "@/components/dashboard/nav";
import { MoonMark } from "@/components/night-sky";
import { site } from "@/content/site";
import { isAdmin } from "@/lib/admin";
import { signOut } from "@/lib/auth";
import { requireUserOrRedirect } from "@/lib/auth/guards";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: { default: "Dashboard", template: `%s · Dashboard · ${site.name}` },
  robots: { index: false, follow: false },
};

const ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/jobs", label: "Jobs" },
  { href: "/dashboard/jobs/new", label: "New job" },
  { href: "/dashboard/pcs", label: "Your PCs" },
  { href: "/dashboard/earnings", label: "Earnings" },
  { href: "/dashboard/credits", label: "Time-Bank" },
  { href: "/dashboard/emi", label: "EMI simulator" },
  { href: "/dashboard/account", label: "Account" },
];

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const user = await requireUserOrRedirect();
  // The Admin link is a convenience only: /admin checks everything itself,
  // on every request. Both keys are read fresh here too (never from the session).
  const admin = await isAdmin(await getDb(), user.id, getEnv().ADMIN_EMAILS);
  const items = admin ? [...ITEMS, { href: "/admin", label: "Admin" }] : ITEMS;

  async function logout() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <>
      <header className="border-b border-navy/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 rounded text-lg font-semibold text-lavender no-underline">
            <MoonMark />
            <span>{site.name}</span>
          </Link>
          <form action={logout}>
            <button type="submit" className="rounded border border-mist/60 px-3 py-1.5 text-sm text-lavender hover:border-lavender">
              Log out
            </button>
          </form>
        </div>
      </header>
      <DashboardNav items={items} />
      {/* Money is shown on these pages, and it's all simulated: say so on every one. */}
      <p className="mx-auto mt-4 w-full max-w-6xl px-4 text-sm text-mist sm:px-6">{site.footer.demo} No real money moves.</p>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        {children}
      </main>
    </>
  );
}
