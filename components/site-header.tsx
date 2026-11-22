import Link from "next/link";
import { nav, site } from "@/content/site";
import { MoonMark } from "./night-sky";

/**
 * Desktop: inline nav. Mobile: a <details> disclosure, which works with the
 * keyboard and without JavaScript.
 */
export function SiteHeader() {
  return (
    <header className="border-b border-navy/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 rounded text-lg font-semibold text-lavender no-underline">
          <MoonMark />
          <span>{site.name}</span>
        </Link>

        <nav aria-label="Main" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {nav.map((item) => (
              <li key={item.path}>
                <Link href={item.path} className="rounded px-3 py-2 text-sm text-mist hover:text-lavender">
                  {item.name}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/waitlist" className="ml-2 rounded bg-orange px-3 py-2 text-sm font-semibold text-deep hover:bg-lavender">
                Join the waitlist
              </Link>
            </li>
          </ul>
        </nav>

        <details className="group relative lg:hidden">
          <summary className="cursor-pointer list-none rounded border border-navy px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
            {site.menu}
          </summary>
          <nav aria-label="Main" className="absolute right-0 z-20 mt-2 w-64 rounded border border-navy bg-deep p-2 shadow-lg">
            <ul className="flex flex-col">
              {nav.map((item) => (
                <li key={item.path}>
                  <Link href={item.path} className="block rounded px-3 py-3 text-lavender hover:bg-navy">
                    {item.name}
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/waitlist" className="mt-1 block rounded bg-orange px-3 py-3 font-semibold text-deep">
                  Join the waitlist
                </Link>
              </li>
            </ul>
          </nav>
        </details>
      </div>
    </header>
  );
}
