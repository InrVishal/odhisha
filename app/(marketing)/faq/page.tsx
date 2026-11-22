import type { Metadata } from "next";
import { PageHero } from "@/components/content";
import { faq } from "@/content/site";

export const metadata: Metadata = { title: faq.meta.name, description: faq.meta.description };

export default function Page() {
  return (
    <main id="main" className="flex-1">
      <PageHero heading={faq.heading} />
      <div className="mx-auto max-w-3xl space-y-3 px-4 sm:px-6">
        {faq.items.map((item) => (
          <details key={item.q} className="group rounded-lg border border-navy bg-deep/70 p-5 open:border-orange/60">
            <summary className="cursor-pointer list-none text-lg font-semibold text-lavender [&::-webkit-details-marker]:hidden">
              <h2 className="inline">{item.q}</h2>
            </summary>
            <div className="mt-3 space-y-3 leading-7 text-mist">
              {item.a.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          </details>
        ))}
      </div>
    </main>
  );
}
