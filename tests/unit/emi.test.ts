import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMI_DEFAULTS, EmiInputError, emiPaise, MAX_PAYOFF_MONTHS, monthInterestPaise, monthlyEarnings, simulateEmi, UTILISATION_SCENARIOS, utilisationScenarios, type EmiInput } from "@/lib/emi";
import { DEFAULT_OWNER_RATE_PAISE_PER_HR, powerCostPerHourPaise } from "@/lib/pricing";

const base: EmiInput = {
  gpuClass: "rtx3060",
  pricePaise: 2_600_000,
  downPaymentPaise: 0,
  annualRateBps: 1500,
  months: 12,
  hoursPerNight: 8,
  nightsPerMonth: 30,
  utilisationPct: 50,
  ownerRatePaisePerHr: 2500,
  tariffPaisePerKwh: 900,
};

describe("the EMI formula", () => {
  it("matches the textbook example: ₹1,00,000 at 12% for 12 months is ₹8,884.88", () => {
    // P·r·(1+r)^n / ((1+r)^n − 1) with r = 1% = 8884.8788… → rounded up to the paisa.
    expect(emiPaise(10_000_000, 1200, 12)).toBe(888_488);
  });

  it("₹26,000 at 15% for 12 months", () => {
    // r = 0.0125: 26000 × 0.0125 × 1.0125^12 / (1.0125^12 − 1) = 2346.715…
    expect(emiPaise(2_600_000, 1500, 12)).toBe(234_672);
  });

  it("at 0% it is the price split evenly, rounded up", () => {
    expect(emiPaise(1_200_000, 0, 12)).toBe(100_000);
    expect(emiPaise(1_000_001, 0, 12)).toBe(83_334);
    expect(emiPaise(0, 1500, 12)).toBe(0);
  });

  it("one month's interest is rounded half up to the paisa", () => {
    expect(monthInterestPaise(10_000_000, 1200)).toBe(100_000);
    expect(monthInterestPaise(150, 1200)).toBe(2); // 1.5 paise → 2
    expect(monthInterestPaise(149, 1200)).toBe(1);
  });

  it.each([
    ["negative price", () => emiPaise(-1, 1500, 12)],
    ["fractional paise", () => emiPaise(1.5, 1500, 12)],
    ["zero months", () => emiPaise(100, 1500, 0)],
    ["rate over 60%", () => emiPaise(100, 6001, 12)],
    ["down payment above the price", () => simulateEmi({ ...base, downPaymentPaise: base.pricePaise + 1 })],
    ["utilisation over 100%", () => monthlyEarnings({ ...base, utilisationPct: 101 })],
  ])("rejects %s", (_n, fn) => expect(fn).toThrow(EmiInputError));
});

describe("the schedule", () => {
  it("pays the loan off to exactly ₹0, and interest + principal add up", () => {
    const r = simulateEmi(base);
    expect(r.schedule).toHaveLength(12);
    expect(r.schedule.at(-1)!.balancePaise).toBe(0);
    expect(r.schedule.reduce((s, m) => s + m.principalPaise, 0)).toBe(r.loanPaise);
    expect(r.schedule.reduce((s, m) => s + m.interestPaise, 0)).toBe(r.totalInterestPaise);
    expect(r.totalCostPaise).toBe(r.loanPaise + r.totalInterestPaise);
    for (const m of r.schedule) expect(m.emiPaise).toBe(m.interestPaise + m.principalPaise);
  });

  it("property: for any loan, the schedule ends at 0, no paisa is lost, and the last EMI is within a few paise of the rest", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 50_000_000 }),
        fc.integer({ min: 0, max: 4000 }),
        fc.constantFrom(6, 9, 12, 18, 24),
        (price, bps, months) => {
          const r = simulateEmi({ ...base, pricePaise: price, annualRateBps: bps, months });
          expect(r.schedule.at(-1)!.balancePaise).toBe(0);
          expect(r.schedule.reduce((s, m) => s + m.principalPaise, 0)).toBe(price);
          for (const m of r.schedule.slice(0, -1)) expect(m.emiPaise).toBe(r.emiPaise);
          expect(Math.abs(r.schedule.at(-1)!.emiPaise - r.emiPaise)).toBeLessThanOrEqual(2 * months);
          for (const m of r.schedule) {
            expect(m.fromEarningsPaise + m.fromPocketPaise).toBe(m.emiPaise);
            expect(m.fromEarningsPaise).toBeLessThanOrEqual(r.earnings.netPaise);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a down payment shrinks the loan", () => {
    const r = simulateEmi({ ...base, downPaymentPaise: 600_000 });
    expect(r.loanPaise).toBe(2_000_000);
    expect(r.totalCostPaise).toBe(600_000 + r.schedule.reduce((s, m) => s + m.emiPaise, 0));
  });
});

describe("earnings, with electricity taken out first", () => {
  it("8 hours × 30 nights × 50% = 120 hours a month; net = owner rate × hours", () => {
    const e = monthlyEarnings(base);
    expect(e.workSeconds).toBe(120 * 3600);
    const power = powerCostPerHourPaise(320, 900); // 320 W at ₹9/kWh = 288 paise an hour
    expect(power).toBe(288);
    expect(e.grossPaise).toBe(120 * (2500 + 288));
    expect(e.electricityPaise).toBe(120 * 288);
    expect(e.netPaise).toBe(120 * 2500);
    expect(e.grossPaise - e.electricityPaise).toBe(e.netPaise);
  });

  it("electricity never counts towards the EMI, whatever the tariff", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 50, max: 1500 }), (tariff, util, watts) => {
        const e = monthlyEarnings({ ...base, tariffPaisePerKwh: tariff, utilisationPct: util, watts });
        expect(e.netPaise).toBeLessThanOrEqual(Math.floor((2500 * e.workSeconds) / 3600));
        expect(e.netPaise + e.electricityPaise).toBeLessThanOrEqual(e.grossPaise + 1);
      }),
      { numRuns: 500 },
    );
  });

  it("the default example: ₹3,000 a month after electricity covers 127% of a ₹2,346.72 EMI and pays the GPU off in 10 months", () => {
    const r = simulateEmi(base);
    expect(r.earnings.netPaise).toBe(300_000);
    expect(r.emiPaise).toBe(234_672);
    expect(r.coveredPct).toBe(127);
    expect(r.monthsToPayoff).toBe(Math.ceil(r.totalCostPaise / 300_000));
    expect(r.monthsToPayoff).toBe(10);
    expect(r.schedule.every((m) => m.fromPocketPaise === 0)).toBe(true);
    expect(r.demo).toBe(true);
  });

  it("no work, no payoff: shown as 'not within 10 years', and the owner pays every EMI", () => {
    const r = simulateEmi({ ...base, utilisationPct: 0 });
    expect(r.earnings.netPaise).toBe(0);
    expect(r.monthsToPayoff).toBeNull();
    expect(r.coveredPct).toBe(0);
    expect(r.schedule.every((m) => m.fromPocketPaise === m.emiPaise)).toBe(true);
    // A tiny trickle is also "not within 10 years".
    const slow = simulateEmi({ ...base, pricePaise: 16_500_000, gpuClass: "rtx4090", utilisationPct: 1, hoursPerNight: 1 });
    expect(slow.monthsToPayoff).toBeNull();
    expect(MAX_PAYOFF_MONTHS).toBe(120);
  });

  it("defaults are the documented ones: 40% of night hours with work, and the pricing page's owner rate", () => {
    expect(EMI_DEFAULTS).toMatchObject({ annualRateBps: 1500, months: 12, hoursPerNight: 8, nightsPerMonth: 30, utilisationPct: 40, ownerRatePaisePerHr: 2500, tariffPaisePerKwh: 900 });
    expect(EMI_DEFAULTS.ownerRatePaisePerHr).toBe(DEFAULT_OWNER_RATE_PAISE_PER_HR);
  });

  it("at the defaults (40%): ₹2,400 a month after ₹276.48 of electricity, 102% of the EMI, paid off in 12 months", () => {
    const r = simulateEmi({ ...base, utilisationPct: EMI_DEFAULTS.utilisationPct });
    expect(r.earnings.workSeconds).toBe(96 * 3600);
    expect(r.earnings.electricityPaise).toBe(27_648);
    expect(r.earnings.netPaise).toBe(240_000);
    expect(r.coveredPct).toBe(102);
    expect(r.monthsToPayoff).toBe(12);
  });

  it("payoff is shown at 20%, 40% and 70% of night hours: 24, 12 and 7 months", () => {
    expect(UTILISATION_SCENARIOS).toEqual([20, 40, 70]);
    const s = utilisationScenarios(base);
    expect(s.map((x) => [x.utilisationPct, x.netPaise, x.coveredPct, x.monthsToPayoff])).toEqual([
      [20, 120_000, 51, 24],
      [40, 240_000, 102, 12],
      [70, 420_000, 178, 7],
    ]);
    // More work never makes payoff slower.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), (a, b) => {
        const [lo, hi] = utilisationScenarios(base, [Math.min(a, b), Math.max(a, b)]);
        expect(hi!.netPaise).toBeGreaterThanOrEqual(lo!.netPaise);
        if (lo!.monthsToPayoff !== null) expect(hi!.monthsToPayoff).not.toBeNull();
        if (lo!.monthsToPayoff !== null && hi!.monthsToPayoff !== null) expect(hi!.monthsToPayoff).toBeLessThanOrEqual(lo!.monthsToPayoff);
      }),
      { numRuns: 300 },
    );
  });
});
