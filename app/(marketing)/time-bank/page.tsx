import type { Metadata } from "next";
import { CtaLink, PageHero, Sections } from "@/components/content";
import { timeBank } from "@/content/site";

export const metadata: Metadata = { title: timeBank.meta.name, description: timeBank.meta.description };

export default function Page() {
  return (
    <main id="main" className="flex-1">
      <PageHero heading={timeBank.heading} intro={timeBank.intro} />
      <Sections sections={timeBank.sections} />
      <div className="mx-auto mt-12 max-w-3xl px-4 sm:px-6">
        <CtaLink href="/waitlist">{timeBank.cta}</CtaLink>
      </div>
    </main>
  );
}
