import type { Metadata } from "next";
import { PageHero, Sections } from "@/components/content";
import { fill } from "@/content/derived";
import { privacy, site } from "@/content/site";
import { getEnv } from "@/lib/env";

export const metadata: Metadata = { title: privacy.meta.name, description: privacy.meta.description };

export default function Page() {
  const email = getEnv().CONTACT_EMAIL;
  // Never invent a contact address: say so plainly until one is configured.
  const contact = email ? fill(privacy.contactLine, { email }) : site.footer.contactMissing;
  const sections = privacy.sections.map((s) => ({ ...s, body: s.body.map((p) => p.replace("{contact}", contact)) }));
  return (
    <main id="main" className="flex-1">
      <PageHero heading={privacy.heading} intro={privacy.intro} />
      <Sections sections={sections} />
    </main>
  );
}
