"use client";

import { useId, useState } from "react";
import { pricing } from "@/content/site";
import {
  DEFAULT_TARIFF_PAISE_PER_KWH,
  DEFAULT_WATTS,
  EXAMPLE_OWNER_RATE_PAISE_PER_HR,
  formatPaise,
  GPU_LABELS,
  parseHoursToSeconds,
  parseRupeesToPaise,
  priceJob,
  PricingInputError,
  type GpuClass,
  type PriceBreakdown,
} from "@/lib/pricing";

const c = pricing.calculator;
const CLASSES = Object.keys(GPU_LABELS) as GpuClass[];

function paiseToInput(p: number): string {
  return p % 100 === 0 ? String(p / 100) : `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;
}

type Result = { ok: true; b: PriceBreakdown } | { ok: false; field: "hours" | "tariff" | "rate"; message: string };

function compute(gpu: GpuClass, hours: string, tariff: string, rate: string): Result {
  const seconds = parseHoursToSeconds(hours);
  if (seconds === null || seconds === 0) return { ok: false, field: "hours", message: c.invalidHours };
  const tariffPaise = parseRupeesToPaise(tariff);
  if (tariffPaise === null || tariffPaise === 0) return { ok: false, field: "tariff", message: c.invalidRupees };
  const ratePaise = parseRupeesToPaise(rate);
  if (ratePaise === null) return { ok: false, field: "rate", message: c.invalidRupees };
  try {
    return {
      ok: true,
      b: priceJob([{ gpuSeconds: seconds, watts: DEFAULT_WATTS[gpu], tariffPaisePerKwh: tariffPaise, ownerRatePaisePerHr: ratePaise }]),
    };
  } catch (e) {
    if (e instanceof PricingInputError) return { ok: false, field: "hours", message: c.outOfRange };
    throw e;
  }
}

export function Calculator() {
  const id = useId();
  const [gpu, setGpu] = useState<GpuClass>("rtx4070");
  const [hours, setHours] = useState("10");
  const [tariff, setTariff] = useState(paiseToInput(DEFAULT_TARIFF_PAISE_PER_KWH));
  const [rate, setRate] = useState(paiseToInput(EXAMPLE_OWNER_RATE_PAISE_PER_HR.rtx4070));

  const result = compute(gpu, hours, tariff, rate);
  const err = (f: "hours" | "tariff" | "rate") => (!result.ok && result.field === f ? result.message : null);

  const field = (
    name: "hours" | "tariff" | "rate",
    label: string,
    hint: string,
    value: string,
    set: (v: string) => void,
  ) => {
    const error = err(name);
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-${name}`} className="font-medium text-lavender">
          {label}
        </label>
        <input
          id={`${id}-${name}`}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => set(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-${name}-hint${error ? ` ${id}-${name}-err` : ""}`}
          className="rounded border border-mist/60 bg-night px-3 py-2 text-lavender"
        />
        <p id={`${id}-${name}-hint`} className="text-sm text-mist">
          {hint}
        </p>
        {error ? (
          <p id={`${id}-${name}-err`} className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <form className="grid gap-8 rounded-xl border border-navy bg-deep/80 p-6 md:grid-cols-2" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-gpu`} className="font-medium text-lavender">
            {c.gpuLabel}
          </label>
          <select
            id={`${id}-gpu`}
            value={gpu}
            onChange={(e) => {
              const next = e.target.value as GpuClass;
              setGpu(next);
              setRate(paiseToInput(EXAMPLE_OWNER_RATE_PAISE_PER_HR[next]));
            }}
            className="rounded border border-mist/60 bg-night px-3 py-2 text-lavender"
          >
            {CLASSES.map((k) => (
              <option key={k} value={k}>
                {GPU_LABELS[k]} ({(DEFAULT_WATTS[k] / 1000).toFixed(2)} kW)
              </option>
            ))}
          </select>
        </div>
        {field("hours", c.hoursLabel, c.hoursHint, hours, setHours)}
        {field("tariff", c.tariffLabel, c.tariffHint, tariff, setTariff)}
        {field("rate", c.rateLabel, c.rateHint, rate, setRate)}
      </div>

      <div>
        <h3 className="text-lg font-semibold text-lavender">{c.breakdownHeading}</h3>
        <output htmlFor={`${id}-gpu ${id}-hours ${id}-tariff ${id}-rate`} aria-live="polite" className="mt-3 block">
          {result.ok ? (
            <>
              <table className="w-full text-left">
                <tbody className="divide-y divide-navy">
                  {(
                    [
                      [c.lines.ownerPay, result.b.ownerPayPaise],
                      [c.lines.electricity, result.b.electricityPaise],
                      [c.lines.buffer, result.b.verificationBufferPaise],
                      [c.lines.fee, result.b.nightshiftFeePaise],
                    ] as const
                  ).map(([label, value]) => (
                    <tr key={label}>
                      <th scope="row" className="py-2 pr-4 font-normal text-mist">
                        {label}
                      </th>
                      <td className="py-2 text-right font-mono text-lavender">{formatPaise(value)}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="py-3 pr-4 font-semibold text-lavender">
                      {c.lines.total}
                    </th>
                    <td className="py-3 text-right font-mono text-2xl font-semibold text-orange">{formatPaise(result.b.totalPaise)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-4 text-sm text-mist">
                {c.ownerGets
                  .replace("{ownerReceives}", formatPaise(result.b.ownerReceivesPaise))
                  .replace("{electricity}", formatPaise(result.b.electricityPaise))}
              </p>
            </>
          ) : (
            <p className="text-mist">{result.message}</p>
          )}
        </output>
      </div>
    </form>
  );
}
