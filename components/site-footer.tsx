import Link from "next/link";
import { footerNav, nav, site } from "@/content/site";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-navy/60">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm text-mist sm:grid-cols-2 sm:px-6">
        <div className="space-y-2">
          <p className="font-semibold text-lavender">{site.name}</p>
          <p>{site.tagline}</p>
          <p>{site.footer.team}</p>
          <p>{site.footer.demo}</p>
        </div>
        <nav aria-label="Footer">
          <ul className="grid grid-cols-2 gap-2">
            {[...nav, ...footerNav].map((item) => (
              <li key={item.path}>
                <Link href={item.path} className="text-mist underline hover:text-lavender">
                  {item.name}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/signin" className="text-mist underline hover:text-lavender">
                Log in
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
