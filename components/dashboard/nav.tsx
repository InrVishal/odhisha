"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

/** Dashboard section links. The current one is marked for screen readers too. */
export function DashboardNav({ items }: { items: readonly NavItem[] }) {
  const path = usePathname();
  const matches = (href: string) => (href === "/dashboard" ? path === href : path === href || path.startsWith(`${href}/`));
  // "New job" lives under /dashboard/jobs, so the longest match wins.
  const best = items.filter((i) => matches(i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label="Dashboard" className="border-b border-navy/60">
      <ul className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6">
        {items.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              aria-current={best === i.href ? "page" : undefined}
              className={`block border-b-2 px-3 py-3 text-sm whitespace-nowrap no-underline ${
                best === i.href ? "border-orange text-lavender" : "border-transparent text-mist hover:text-lavender"
              }`}
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
