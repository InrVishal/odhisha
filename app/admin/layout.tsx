import type { Metadata } from "next";
import Link from "next/link";
import { MoonMark } from "@/components/night-sky";
import { site } from "@/content/site";
import { adminOr404 } from "@/lib/auth/guards";

export const metadata: Metadata = {
  title: { default: "Admin", template: `%s · Admin · ${site.name}` },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Admin check 1 of 3: this layout. Layouts and pages render in parallel, so
 * the page and every server action and API route check again on their own
 * (lib/auth/guards.ts, adminOr404). Anyone who isn't an admin gets the plain
 * 404 page. proxy.ts plays no part in it, and no request header is trusted.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await adminOr404();
  return (
    <>
      <header className="border-b border-navy/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 rounded text-lg font-semibold text-lavender no-underline">
            <MoonMark />
            <span>{site.name} admin</span>
          </Link>
          <Link href="/dashboard" className="rounded border border-mist/60 px-3 py-1.5 text-sm text-lavender no-underline hover:border-lavender">
            Back to the dashboard
          </Link>
        </div>
      </header>
      {/* Money is shown on these pages, and it's all simulated: say so. */}
      <p className="mx-auto mt-4 w-full max-w-6xl px-4 text-sm text-mist sm:px-6">{site.footer.demo} No real money moves.</p>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        {children}
      </main>
    </>
  );
}
