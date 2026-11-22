import type { ReactNode } from "react";

export function PageTitle({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight text-lavender">{title}</h1>
        {intro ? <p className="mt-2 text-mist">{intro}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap gap-3">{children}</div> : null}
    </div>
  );
}

export function Card({ title, children, id }: { title?: string; children: ReactNode; id?: string }) {
  const headingId = title ? `${id ?? slug(title)}-title` : undefined;
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-navy bg-deep/60 p-5">
      {title ? (
        <h2 id={headingId} className="mb-4 text-lg font-semibold text-lavender">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-lg border border-navy bg-deep/60 p-4">
      <p className="text-sm text-mist">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-lavender">{value}</p>
      {note ? <p className="mt-1 text-xs text-mist">{note}</p> : null}
    </div>
  );
}

const TONES = {
  good: "border-emerald-300/60 text-emerald-200",
  warn: "border-orange/70 text-orange",
  bad: "border-danger/70 text-danger",
  neutral: "border-mist/50 text-mist",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

/** A horizontally scrollable table that keyboard users can scroll too. */
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Scrollable regions must be focusable so keyboard users can scroll them.
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded border border-navy">
      <table className="w-full min-w-[36rem] text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return (
    <th scope="col" className={`border-b border-navy bg-deep px-3 py-2 font-semibold text-lavender ${right ? "text-right" : ""}`}>
      {children}
    </th>
  );
}

export function Td({ children, right = false, mono = false }: { children: ReactNode; right?: boolean; mono?: boolean }) {
  return (
    <td className={`border-b border-navy/50 px-3 py-2 align-top text-mist ${right ? "text-right" : ""} ${mono ? "font-mono text-xs" : ""}`}>
      {children}
    </td>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-dashed border-navy p-6 text-center text-mist">{children}</div>;
}

export const buttonClass =
  "inline-block rounded bg-orange px-4 py-2 font-semibold text-deep no-underline hover:bg-lavender disabled:opacity-60";
export const secondaryButtonClass =
  "inline-block rounded border border-mist/60 px-4 py-2 text-lavender no-underline hover:border-lavender disabled:opacity-60";
export const inputClass = "rounded border border-mist/60 bg-night px-3 py-2 text-lavender";
