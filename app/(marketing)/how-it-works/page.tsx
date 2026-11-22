import type { Metadata } from "next";
import { PageHero, Sections } from "@/components/content";
import { howItWorks } from "@/content/site";

export const metadata: Metadata = { title: howItWorks.meta.name, description: howItWorks.meta.description };

export default function Page() {
  return (
    <main id="main" className="flex-1">
      <PageHero heading={howItWorks.heading} intro={howItWorks.intro} />
      <Sections sections={howItWorks.sections} />
    </main>
  );
}
