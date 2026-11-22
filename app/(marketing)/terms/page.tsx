import type { Metadata } from "next";
import { PageHero, Sections } from "@/components/content";
import { terms } from "@/content/site";

export const metadata: Metadata = { title: terms.meta.name, description: terms.meta.description };

export default function Page() {
  return (
    <main id="main" className="flex-1">
      <PageHero heading={terms.heading} intro={terms.intro} />
      <Sections sections={terms.sections} />
    </main>
  );
}
