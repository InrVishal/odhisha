import type { Metadata } from "next";
import { CtaLink, PageHero, Sections } from "@/components/content";
import { owners } from "@/content/site";

export const metadata: Metadata = { title: owners.meta.name, description: owners.meta.description };

export default function Page() {
  return (
    <main id="main" className="flex-1">
      <PageHero heading={owners.heading} intro={owners.intro} />
      <Sections sections={owners.sections} />
      <div className="mx-auto mt-12 max-w-3xl px-4 sm:px-6">
        <CtaLink href="/waitlist?as=owner">{owners.cta}</CtaLink>
      </div>
    </main>
  );
}
