import type { Metadata } from "next";
import { PageHero } from "@/components/content";
import { waitlist } from "@/content/site";
import { WaitlistForm } from "./waitlist-form";

export const metadata: Metadata = { title: waitlist.meta.name, description: waitlist.meta.description };

export default async function WaitlistPage({ searchParams }: PageProps<"/waitlist">) {
  const { as } = await searchParams;
  const defaultInterest = as === "owner" || as === "buyer" ? as : "both";
  return (
    <main id="main" className="flex-1">
      <PageHero heading={waitlist.heading} intro={waitlist.intro} />
      <div className="mx-auto max-w-xl px-4 sm:px-6">
        <WaitlistForm defaultInterest={defaultInterest} />
      </div>
    </main>
  );
}
