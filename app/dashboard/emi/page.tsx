import type { Metadata } from "next";
import { PageTitle } from "@/components/dashboard/ui";
import { pageContext } from "../data";
import { EmiSimulator } from "./emi-simulator";

export const metadata: Metadata = { title: "EMI simulator" };

export default async function EmiPage() {
  await pageContext();
  return (
    <>
      <PageTitle
        title="GPU on EMI (simulator)"
        intro="See how much of a GPU's monthly EMI your night-time earnings could cover. Electricity is taken out first, because that part of your pay only covers the power bill."
      />
      <p role="note" className="mb-6 rounded border border-orange/70 p-3 text-sm text-lavender">
        Demo mode: this is a simulator. NightShift doesn&apos;t lend money, arrange loans or promise any amount of work. Prices
        and rates here are examples; change them to your own.
      </p>
      <EmiSimulator />
    </>
  );
}
