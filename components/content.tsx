import Link from "next/link";
import type { ReactNode } from "react";
import { fill } from "@/content/derived";
import type { Section, Step } from "@/content/site";

export function PageHero({
  heading,
  intro,
  wide = false,
  children,
}: {
  heading: string;
  intro?: string;
  /** Match pages whose content is wider than the default reading column. */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`mx-auto ${wide ? "max-w-5xl" : "max-w-3xl"} px-4 pt-16 pb-8 sm:px-6`}>
      <h1 className="text-4xl font-semibold tracking-tight text-lavender sm:text-5xl">{heading}</h1>
      {intro ? <p className="mt-5 text-lg leading-8 text-mist">{fill(intro)}</p> : null}
      {children}
    </div>
  );
}

export function Sections({ sections }: { sections: readonly Section[] }) {
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 sm:px-6">
      {sections.map((s) => (
        <section key={s.heading} aria-labelledby={slug(s.heading)}>
          <h2 id={slug(s.heading)} className="text-2xl font-semibold text-lavender">
            {s.heading}
          </h2>
          <div className="mt-3 space-y-3 leading-7 text-mist">
            {s.body.map((p) => (
              <p key={p}>{fill(p)}</p>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function StepList({ steps, ordered = false }: { steps: readonly Step[]; ordered?: boolean }) {
  const List = ordered ? "ol" : "ul";
  return (
    <List className="grid gap-4 sm:grid-cols-2">
      {steps.map((s, i) => (
        <li key={s.title} className="rounded-lg border border-navy bg-deep/70 p-5">
          <h3 className="flex items-baseline gap-3 text-lg font-semibold text-lavender">
            {ordered ? (
              <span aria-hidden="true" className="font-mono text-orange">
                {String(i + 1).padStart(2, "0")}
              </span>
            ) : null}
            {s.title}
          </h3>
          <p className="mt-2 leading-7 text-mist">{fill(s.body)}</p>
        </li>
      ))}
    </List>
  );
}

export function CtaLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  const cls =
    variant === "primary"
      ? "bg-orange text-deep hover:bg-lavender"
      : "border border-lavender/70 text-lavender hover:border-orange hover:text-orange";
  return (
    <Link href={href} className={`inline-block rounded px-5 py-3 font-semibold no-underline ${cls}`}>
      {children}
    </Link>
  );
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
