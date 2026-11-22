import type { Metadata } from "next";
import { PageHero } from "@/components/content";
import { pricing } from "@/content/site";
import { DEFAULT_TARIFF_PAISE_PER_KWH, DEFAULT_WATTS, formatPaise, GPU_LABELS, powerCostPerHourPaise, type GpuClass } from "@/lib/pricing";
import { Calculator } from "./calculator";

export const metadata: Metadata = { title: pricing.meta.name, description: pricing.meta.description };

export default function PricingPage() {
  return (
    <main id="main" className="flex-1">
      <PageHero heading={pricing.heading} intro={pricing.intro} wide />

      <section aria-labelledby="try-it" className="mx-auto max-w-5xl px-4 sm:px-6">
        <h2 id="try-it" className="text-2xl font-semibold text-lavender">
          {pricing.calculatorHeading}
        </h2>
        <p className="mt-2 text-mist">{pricing.calculatorNote}</p>
        <div className="mt-5">
          <Calculator />
        </div>
      </section>

      <div className="mx-auto mt-14 grid max-w-5xl gap-10 px-4 sm:px-6 md:grid-cols-2">
        <section aria-labelledby="formula">
          <h2 id="formula" className="text-2xl font-semibold text-lavender">
            {pricing.formulaHeading}
          </h2>
          <ol className="mt-4 list-decimal space-y-2 pl-5 leading-7 text-mist">
            {pricing.formula.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="draw">
          <h2 id="draw" className="text-2xl font-semibold text-lavender">
            {pricing.drawHeading}
          </h2>
          <table className="mt-4 w-full text-left">
            <thead>
              <tr className="border-b border-navy text-sm text-mist">
                <th scope="col" className="py-2 font-medium">PC</th>
                <th scope="col" className="py-2 font-medium">Draw</th>
                <th scope="col" className="py-2 text-right font-medium">Electricity per hour at ₹{DEFAULT_TARIFF_PAISE_PER_KWH / 100}/unit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy">
              {(Object.keys(GPU_LABELS) as GpuClass[]).map((k) => (
                <tr key={k}>
                  <th scope="row" className="py-2 font-normal text-lavender">{GPU_LABELS[k]}</th>
                  <td className="py-2 font-mono text-mist">{(DEFAULT_WATTS[k] / 1000).toFixed(2)} kW</td>
                  <td className="py-2 text-right font-mono text-lavender">
                    {formatPaise(powerCostPerHourPaise(DEFAULT_WATTS[k], DEFAULT_TARIFF_PAISE_PER_KWH))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm text-mist">{pricing.drawNote}</p>
        </section>
      </div>

      <section aria-labelledby="notes" className="mx-auto mt-14 max-w-5xl px-4 sm:px-6">
        <h2 id="notes" className="text-2xl font-semibold text-lavender">
          {pricing.notesHeading}
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 leading-7 text-mist">
          {pricing.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
