import type { Metadata } from "next";
import { CtaLink, PageHero, Sections } from "@/components/content";
import { builders } from "@/content/site";

export const metadata: Metadata = { title: builders.meta.name, description: builders.meta.description };

export default function Page() {
  return (
    <main id="main" className="flex-1">
      <PageHero heading={builders.heading} intro={builders.intro} />
      <Sections sections={builders.sections} />
      <div className="mx-auto mt-12 max-w-3xl px-4 sm:px-6">
        <CtaLink href="/waitlist?as=buyer">{builders.cta}</CtaLink>
      </div>
    </main>
  );
}
