"use client";

import { useId, useMemo, useState } from "react";
import { rupees } from "@/components/dashboard/format";
import { Card, inputClass, Stat, TableWrap, Td, Th } from "@/components/dashboard/ui";
import { EMI_DEFAULTS, EmiInputError, EXAMPLE_GPU_PRICE_PAISE, simulateEmi, utilisationScenarios, type EmiResult, type Scenario } from "@/lib/emi";
import { DEFAULT_WATTS, GPU_LABELS, parseRupeesToPaise, type GpuClass } from "@/lib/pricing";

const CLASSES = Object.keys(GPU_LABELS) as GpuClass[];
const MONTHS = [6, 9, 12, 18, 24];
const rs = (paise: number) => String(paise / 100);

function whole(v: string, min: number, max: number): number | null {
  if (!/^\s*\d+\s*$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** "15" → 1500 bps, "15.5" → 1550. */
function percentToBps(v: string): number | null {
  const m = /^\s*(\d{1,2})(?:\.(\d{1,2}))?\s*$/.exec(v);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
}

export function EmiSimulator() {
  const id = useId();
  const [gpu, setGpu] = useState<GpuClass>("rtx3060");
  const [price, setPrice] = useState(rs(EXAMPLE_GPU_PRICE_PAISE.rtx3060));
  const [down, setDown] = useState("0");
  const [rate, setRate] = useState(String(EMI_DEFAULTS.annualRateBps / 100));
  const [months, setMonths] = useState<number>(EMI_DEFAULTS.months);
  const [hours, setHours] = useState(String(EMI_DEFAULTS.hoursPerNight));
  const [nights, setNights] = useState(String(EMI_DEFAULTS.nightsPerMonth));
  const [util, setUtil] = useState(String(EMI_DEFAULTS.utilisationPct));
  const [ownerRate, setOwnerRate] = useState(rs(EMI_DEFAULTS.ownerRatePaisePerHr));
  const [tariff, setTariff] = useState(rs(EMI_DEFAULTS.tariffPaisePerKwh));

  const out = useMemo((): { result?: EmiResult; scenarios?: Scenario[]; error?: string } => {
    const pricePaise = parseRupeesToPaise(price);
    const downPaise = parseRupeesToPaise(down);
    const bps = percentToBps(rate);
    const h = whole(hours, 0, 16);
    const n = whole(nights, 0, 31);
    const u = whole(util, 0, 100);
    const r = parseRupeesToPaise(ownerRate);
    const t = parseRupeesToPaise(tariff);
    if (pricePaise === null || pricePaise <= 0) return { error: "Enter the GPU's price in rupees." };
    if (downPaise === null || downPaise > pricePaise) return { error: "The down payment must be between ₹0 and the price." };
    if (bps === null || bps > 6000) return { error: "Interest must be a yearly rate from 0% to 60%." };
    if (h === null || n === null || u === null) return { error: "Hours (0–16), nights (0–31) and the share of nights with work (0–100%) must be whole numbers." };
    if (r === null || t === null || t <= 0) return { error: "Enter your rate and your electricity tariff in rupees." };
    try {
      const input = {
        gpuClass: gpu,
        pricePaise,
        downPaymentPaise: downPaise,
        annualRateBps: bps,
        months,
        hoursPerNight: h,
        nightsPerMonth: n,
        utilisationPct: u,
        ownerRatePaisePerHr: r,
        tariffPaisePerKwh: t,
      };
      return { result: simulateEmi(input), scenarios: utilisationScenarios(input) };
    } catch (e) {
      return { error: e instanceof EmiInputError ? e.message : "Those numbers don't work. Check them and try again." };
    }
  }, [gpu, price, down, rate, months, hours, nights, util, ownerRate, tariff]);

  const field = (key: string, label: string, value: string, set: (v: string) => void, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${key}`} className="text-sm text-lavender">
        {label}
      </label>
      <input id={`${id}-${key}`} inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} className={inputClass} />
      {hint ? <span className="text-xs text-mist">{hint}</span> : null}
    </div>
  );

  const res = out.result;
  return (
    <div className="space-y-6">
      <Card title="Your GPU and loan">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-gpu`} className="text-sm text-lavender">
              GPU
            </label>
            <select
              id={`${id}-gpu`}
              value={gpu}
              onChange={(e) => {
                const g = e.target.value as GpuClass;
                setGpu(g);
                setPrice(rs(EXAMPLE_GPU_PRICE_PAISE[g]));
              }}
              className={inputClass}
            >
              {CLASSES.map((c) => (
                <option key={c} value={c}>
                  {GPU_LABELS[c]}
                </option>
              ))}
            </select>
            <span className="text-xs text-mist">Draws about {DEFAULT_WATTS[gpu]} W while working.</span>
          </div>
          {field("price", "Price (₹)", price, setPrice, "An example price. Type the one you were quoted.")}
          {field("down", "Down payment (₹)", down, setDown)}
          {field("rate", "Interest (% a year)", rate, setRate)}
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-months`} className="text-sm text-lavender">
              Months
            </label>
            <select id={`${id}-months`} value={months} onChange={(e) => setMonths(Number(e.target.value))} className={inputClass}>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <Card title="Your nights on NightShift">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field("hours", "Hours a night", hours, setHours)}
          {field("nights", "Nights a month", nights, setNights)}
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-util`} className="text-sm text-lavender">
              Share of those hours with work: {util}%
            </label>
            <input
              id={`${id}-util`}
              type="range"
              min={0}
              max={100}
              step={5}
              value={util}
              onChange={(e) => setUtil(e.target.value)}
              aria-valuetext={`${util}%`}
              className="accent-orange"
            />
            <span className="text-xs text-mist">Starts at 40%. Nobody can promise work every night: try 20% too.</span>
          </div>
          {field("ownerRate", "Your rate (₹ per hour of work)", ownerRate, setOwnerRate, "₹25 an hour: the same rate the pricing page uses.")}
          {field("tariff", "Your electricity tariff (₹ per kWh)", tariff, setTariff)}
        </div>
      </Card>

      {out.error ? (
        <p role="alert" className="rounded border border-danger p-3 text-sm text-danger">
          {out.error}
        </p>
      ) : null}

      {res ? (
        <section aria-label="Result" aria-live="polite" className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Monthly EMI" value={rupees(res.emiPaise)} note={`${months} months, ${rupees(res.totalInterestPaise)} interest in all`} />
            <Stat
              label="Projected earnings a month, after electricity (not guaranteed)"
              value={rupees(res.earnings.netPaise)}
              note={`${rupees(res.earnings.grossPaise)} paid, minus ${rupees(res.earnings.electricityPaise)} for electricity`}
            />
            <Stat label="Projected share of the EMI covered" value={`${res.coveredPct}%`} note="Projected, not guaranteed" />
            <Stat
              label="Projected months to pay off the whole GPU"
              value={res.monthsToPayoff === null ? "Not within 10 years" : String(res.monthsToPayoff)}
              note={`Not guaranteed. Price, down payment and interest: ${rupees(res.totalCostPaise)}`}
            />
          </div>

          {out.scenarios ? (
            <Card title="If there's less work, or more (projected, not guaranteed)">
              <TableWrap label="Payoff at 20%, 40% and 70% of night hours with work">
                <thead>
                  <tr>
                    <Th>Night hours with work</Th>
                    <Th right>Projected earnings a month, after electricity</Th>
                    <Th right>Share of the EMI</Th>
                    <Th right>Projected months to pay off</Th>
                  </tr>
                </thead>
                <tbody>
                  {out.scenarios.map((sc) => (
                    <tr key={sc.utilisationPct}>
                      <Td>{sc.utilisationPct}%</Td>
                      <Td right>{rupees(sc.netPaise)}</Td>
                      <Td right>{sc.coveredPct}%</Td>
                      <Td right>{sc.monthsToPayoff === null ? "Not within 10 years" : sc.monthsToPayoff}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Card>
          ) : null}

          <Card title="Month by month">
            <TableWrap label="EMI schedule">
              <thead>
                <tr>
                  <Th right>Month</Th>
                  <Th right>EMI</Th>
                  <Th right>Interest</Th>
                  <Th right>From earnings</Th>
                  <Th right>From your pocket</Th>
                  <Th right>Loan left</Th>
                </tr>
              </thead>
              <tbody>
                {res.schedule.map((m) => (
                  <tr key={m.month}>
                    <Td right>{m.month}</Td>
                    <Td right>{rupees(m.emiPaise)}</Td>
                    <Td right>{rupees(m.interestPaise)}</Td>
                    <Td right>{rupees(m.fromEarningsPaise)}</Td>
                    <Td right>{rupees(m.fromPocketPaise)}</Td>
                    <Td right>{rupees(m.balancePaise)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <p className="mt-3 text-xs text-mist">
              Projected, not guaranteed: earnings assume {res.earnings.workSeconds / 3600} hours of work a month at your rate. Real
              earnings depend on how many jobs there are. Demo mode: a simulation, not an offer.
            </p>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
