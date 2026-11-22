import type { Metadata } from "next";
import { CtaLink, StepList } from "@/components/content";
import { Moon, NightSky } from "@/components/night-sky";
import { fill } from "@/content/derived";
import { home } from "@/content/site";

export const metadata: Metadata = { description: home.meta.description };

export default function HomePage() {
  return (
    <main id="main" className="flex-1">
      <div className="relative overflow-hidden">
        <NightSky />
        <Moon />
        <div className="relative mx-auto max-w-6xl px-4 pt-20 pb-24 sm:px-6 sm:pt-28">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-lavender sm:text-6xl">{home.hero.heading}</h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-mist">{home.hero.body}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <CtaLink href="/waitlist">{home.hero.primaryCta}</CtaLink>
            <CtaLink href="/pricing" variant="secondary">
              {home.hero.secondaryCta}
            </CtaLink>
          </div>
        </div>
      </div>

      <section aria-labelledby="pillars" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 id="pillars" className="text-3xl font-semibold text-lavender">
          {home.pillarsHeading}
        </h2>
        <div className="mt-8">
          <StepList steps={home.pillars} />
        </div>
      </section>

      <section aria-labelledby="flow" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 id="flow" className="text-3xl font-semibold text-lavender">
          {home.flowHeading}
        </h2>
        <div className="mt-8">
          <StepList steps={home.flow} ordered />
        </div>
      </section>

      <section aria-labelledby="team" className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h2 id="team" className="text-3xl font-semibold text-lavender">
          {home.teamHeading}
        </h2>
        <div className="mt-4 space-y-4 leading-7 text-mist">
          {home.team.map((p) => (
            <p key={p}>{fill(p)}</p>
          ))}
        </div>
      </section>
    </main>
  );
}
