import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav, type NavItem } from "@/components/dashboard/nav";
import { MoonMark } from "@/components/night-sky";
import { site } from "@/content/site";
import { signOut } from "@/lib/auth";
import { requireUserOrRedirect } from "@/lib/auth/guards";

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
  { href: "/dashboard/account", label: "Account" },
];

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const user = await requireUserOrRedirect();
  // The Admin link is a convenience only: the admin page checks the role in
  // the database itself, on every request.
  const items = user.role === "admin" ? [...ITEMS, { href: "/dashboard/admin", label: "Admin" }] : ITEMS;

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
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        {children}
      </main>
    </>
  );
}
