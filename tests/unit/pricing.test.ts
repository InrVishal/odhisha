import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allInPerGpuHourPaise,
  DEFAULT_FEE_BPS,
  DEFAULT_OWNER_RATE_PAISE_PER_HR,
  DEFAULT_TARIFF_PAISE_PER_KWH,
  DEFAULT_VERIFICATION_BUFFER_BPS,
  DEFAULT_WATTS,
  formatPaise,
  LIMITS,
  parseHoursToSeconds,
  parseRupeesToPaise,
  powerCostPerHourPaise,
  priceJob,
  PricingInputError,
  type FragmentPricingInput,
} from "@/lib/pricing";

const HOUR = 3600;

describe("defaults from the brief", () => {
  it("uses ₹9/kWh, a 12% buffer and a 25% fee", () => {
    expect(DEFAULT_TARIFF_PAISE_PER_KWH).toBe(900);
    expect(DEFAULT_VERIFICATION_BUFFER_BPS).toBe(1200);
    expect(DEFAULT_FEE_BPS).toBe(2500);
  });

  it("uses 0.32 / 0.35 / 0.60 kW for the three PC classes", () => {
    expect(DEFAULT_WATTS).toEqual({ rtx3060: 320, rtx4070: 350, rtx4090: 600 });
  });

  it("power cost per hour at ₹9/kWh: ₹2.88, ₹3.15, ₹5.40", () => {
    expect(powerCostPerHourPaise(320, 900)).toBe(288);
    expect(powerCostPerHourPaise(350, 900)).toBe(315);
    expect(powerCostPerHourPaise(600, 900)).toBe(540);
  });
});

describe("priceJob, worked example", () => {
  // RTX 4070 PC, 10 GPU-hours, ₹9/kWh, owner rate ₹25/hr.
  //   electricity = 0.35 kW × 10 h × ₹9  = ₹31.50
  //   owner pay   = ₹25 × 10 h           = ₹250.00
  //   job cost                           = ₹281.50
  //   buffer 12%  = ₹33.78               → buffered ₹315.28
  //   fee 25%     = ₹78.82               → ₹394.10 → rounded up to ₹395
  //   fee line    = ₹395 − ₹315.28       = ₹79.72
  const b = priceJob([{ gpuSeconds: 10 * HOUR, watts: 350, tariffPaisePerKwh: 900, ownerRatePaisePerHr: 2500 }]);

  it("matches the hand calculation", () => {
    expect(b).toEqual({
      ownerPayPaise: 25000,
      electricityPaise: 3150,
      ownerReceivesPaise: 28150,
      verificationBufferPaise: 3378,
      nightshiftFeePaise: 7972,
      totalPaise: 39500,
      gpuSeconds: 36000,
    });
  });

  it("sums fragments the same as one big fragment when nothing rounds", () => {
    const split = priceJob(
      Array.from({ length: 10 }, () => ({ gpuSeconds: HOUR, watts: 350, tariffPaisePerKwh: 900, ownerRatePaisePerHr: 2500 })),
    );
    expect(split).toEqual(b);
  });

  it("prices fragments on different machines with their own watts, tariff and rate", () => {
    const mixed = priceJob([
      { gpuSeconds: HOUR, watts: 320, tariffPaisePerKwh: 900, ownerRatePaisePerHr: 1500 },
      { gpuSeconds: HOUR, watts: 600, tariffPaisePerKwh: 750, ownerRatePaisePerHr: 4500 },
    ]);
    // electricity = 288 + 450 = 738; owner pay = 1500 + 4500 = 6000
    expect(mixed.electricityPaise).toBe(738);
    expect(mixed.ownerPayPaise).toBe(6000);
  });

  it("rounds a tiny job up to ₹1, never down to ₹0", () => {
    const tiny = priceJob([{ gpuSeconds: 1, watts: 320, tariffPaisePerKwh: 900, ownerRatePaisePerHr: 0 }]);
    expect(tiny.electricityPaise).toBe(1); // 0.08 paise rounds up to 1 paisa
    expect(tiny.totalPaise).toBe(100);
  });
});

describe("priceJob input validation", () => {
  const ok: FragmentPricingInput = { gpuSeconds: HOUR, watts: 350, tariffPaisePerKwh: 900, ownerRatePaisePerHr: 2500 };

  it.each([
    ["no fragments", [] as FragmentPricingInput[]],
    ["zero seconds", [{ ...ok, gpuSeconds: 0 }]],
    ["fractional seconds", [{ ...ok, gpuSeconds: 1.5 }]],
    ["zero watts", [{ ...ok, watts: 0 }]],
    ["negative tariff", [{ ...ok, tariffPaisePerKwh: -1 }]],
    ["negative owner rate", [{ ...ok, ownerRatePaisePerHr: -1 }]],
    ["NaN", [{ ...ok, watts: Number.NaN }]],
    ["absurd watts", [{ ...ok, watts: LIMITS.maxWatts + 1 }]],
  ])("rejects %s", (_name, input) => {
    expect(() => priceJob(input)).toThrow(PricingInputError);
  });

  it("rejects out-of-range buffer and fee rates", () => {
    expect(() => priceJob([ok], { feeBps: -1 })).toThrow(PricingInputError);
    expect(() => priceJob([ok], { verificationBufferBps: 10_001 })).toThrow(PricingInputError);
    expect(() => priceJob([ok], { feeBps: 0.5 })).toThrow(PricingInputError);
  });

  it("rejects too many fragments", () => {
    expect(() => priceJob(Array.from({ length: LIMITS.maxFragments + 1 }, () => ok))).toThrow(/too many/);
  });
});

// ─── Property tests ────────────────────────────────────────────────────────

const fragmentArb = fc.record({
  gpuSeconds: fc.integer({ min: 1, max: LIMITS.maxGpuSecondsPerFragment }),
  watts: fc.integer({ min: 1, max: LIMITS.maxWatts }),
  tariffPaisePerKwh: fc.integer({ min: 1, max: LIMITS.maxTariffPaisePerKwh }),
  ownerRatePaisePerHr: fc.integer({ min: 0, max: LIMITS.maxOwnerRatePaisePerHr }),
});
const fragmentsArb = fc.array(fragmentArb, { minLength: 1, maxLength: 40 });
const optionsArb = fc.record({
  verificationBufferBps: fc.integer({ min: 0, max: 10_000 }),
  feeBps: fc.integer({ min: 0, max: 10_000 }),
});

/** Exact power cost of the job as a rational: numerator over 3,600,000 paise. */
function exactPowerNumerator(fs: FragmentPricingInput[]): bigint {
  return fs.reduce((acc, f) => acc + BigInt(f.watts) * BigInt(f.gpuSeconds) * BigInt(f.tariffPaisePerKwh), 0n);
}
function exactOwnerPayNumerator(fs: FragmentPricingInput[]): bigint {
  return fs.reduce((acc, f) => acc + BigInt(f.ownerRatePaisePerHr) * BigInt(f.gpuSeconds), 0n);
}

const RUNS = { numRuns: 2000 };

describe("pricing properties", () => {
  it("the owner is never paid less than their real power cost", () => {
    fc.assert(
      fc.property(fragmentsArb, optionsArb, (fs, opts) => {
        const b = priceJob(fs, opts);
        const exactPower = exactPowerNumerator(fs); // paise × 3,600,000
        expect(BigInt(b.electricityPaise) * 3_600_000n >= exactPower).toBe(true);
        expect(BigInt(b.ownerReceivesPaise) * 3_600_000n >= exactPower).toBe(true);
        // …and electricity is never over-charged by a full paisa or more.
        expect(BigInt(b.electricityPaise - 1) * 3_600_000n < exactPower).toBe(true);
      }),
      RUNS,
    );
  });

  it("owner payout always includes their electricity", () => {
    fc.assert(
      fc.property(fragmentsArb, optionsArb, (fs, opts) => {
        const b = priceJob(fs, opts);
        expect(b.ownerReceivesPaise).toBe(b.ownerPayPaise + b.electricityPaise);
        expect(BigInt(b.ownerPayPaise) * 3600n >= exactOwnerPayNumerator(fs)).toBe(true);
      }),
      RUNS,
    );
  });

  it("price ≥ power cost + owner pay", () => {
    fc.assert(
      fc.property(fragmentsArb, optionsArb, (fs, opts) => {
        const b = priceJob(fs, opts);
        expect(b.totalPaise).toBeGreaterThanOrEqual(b.electricityPaise + b.ownerPayPaise);
      }),
      RUNS,
    );
  });

  it("no rounding loss: the breakdown lines add up to the total exactly", () => {
    fc.assert(
      fc.property(fragmentsArb, optionsArb, (fs, opts) => {
        const b = priceJob(fs, opts);
        expect(b.ownerPayPaise + b.electricityPaise + b.verificationBufferPaise + b.nightshiftFeePaise).toBe(b.totalPaise);
      }),
      RUNS,
    );
  });

  it("every amount is a non-negative safe integer and the total is whole rupees", () => {
    fc.assert(
      fc.property(fragmentsArb, optionsArb, (fs, opts) => {
        const b = priceJob(fs, opts);
        for (const v of Object.values(b)) {
          expect(Number.isSafeInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
        expect(b.totalPaise % 100).toBe(0);
        expect(b.totalPaise).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("matches the brief's formula to within the round-ups (under ₹1 + 4 paise)", () => {
    fc.assert(
      fc.property(fragmentsArb, optionsArb, (fs, opts) => {
        const b = priceJob(fs, opts);
        // Exact formula in rationals over a common denominator D.
        const D = 3_600_000n * 10_000n * 10_000n;
        const jobCost = exactPowerNumerator(fs) + exactOwnerPayNumerator(fs) * 1000n; // over 3,600,000
        const exact = jobCost * BigInt(10_000 + opts.verificationBufferBps) * BigInt(10_000 + opts.feeBps); // over D
        const total = BigInt(b.totalPaise) * D;
        expect(total >= exact).toBe(true); // never under the formula
        // Ceil on electricity, owner pay, buffer and fee each add < 1 paisa
        // (amplified by the later percentages), plus < ₹1 for the rupee round-up.
        const slackPaise = 100n + 4n * 3n; // generous bound for 0–100% rates
        expect(total - exact < slackPaise * D).toBe(true);
      }),
      RUNS,
    );
  });

  it("more GPU time never costs less", () => {
    fc.assert(
      fc.property(fragmentArb, fc.integer({ min: 1, max: 1000 }), (f, extra) => {
        const more = { ...f, gpuSeconds: Math.min(f.gpuSeconds + extra, LIMITS.maxGpuSecondsPerFragment) };
        expect(priceJob([more]).totalPaise).toBeGreaterThanOrEqual(priceJob([f]).totalPaise);
      }),
      RUNS,
    );
  });

  it("is deterministic and doesn't depend on fragment order", () => {
    fc.assert(
      fc.property(fragmentsArb, (fs) => {
        expect(priceJob([...fs].reverse())).toEqual(priceJob(fs));
      }),
      { numRuns: 500 },
    );
  });
});

describe("parsing and formatting", () => {
  it("parses rupee strings to paise without floats", () => {
    expect(parseRupeesToPaise("9")).toBe(900);
    expect(parseRupeesToPaise("9.5")).toBe(950);
    expect(parseRupeesToPaise(" 3.15 ")).toBe(315);
    expect(parseRupeesToPaise("0.1")).toBe(10);
    for (const bad of ["", "-1", "1.234", "abc", "1e3", "١٢"]) expect(parseRupeesToPaise(bad)).toBeNull();
  });

  it("parses hours to whole seconds, rounding up", () => {
    expect(parseHoursToSeconds("2")).toBe(7200);
    expect(parseHoursToSeconds("2.5")).toBe(9000);
    expect(parseHoursToSeconds("0.0001")).toBe(1);
    for (const bad of ["", "-2", "1.23456", "x"]) expect(parseHoursToSeconds(bad)).toBeNull();
  });

  it("formats paise as Indian rupees", () => {
    expect(formatPaise(34000)).toBe("₹340");
    expect(formatPaise(315)).toBe("₹3.15");
    expect(formatPaise(5)).toBe("₹0.05");
    expect(formatPaise(12345600)).toBe("₹1,23,456");
    expect(formatPaise(-250)).toBe("−₹2.50");
    expect(() => formatPaise(1.5)).toThrow(PricingInputError);
  });

  it("round-trips rupee strings", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_99 }), (p) => {
        const s = `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;
        expect(parseRupeesToPaise(s)).toBe(p);
      }),
    );
  });
});

describe("default owner rate and the deck example", () => {
  it("defaults owners to ₹25 an hour", () => {
    expect(DEFAULT_OWNER_RATE_PAISE_PER_HR).toBe(2500);
  });

  it("14 GPU-hours on an RTX 4070 PC at ₹9/unit and ₹25/hr comes to ₹552", () => {
    // electricity 0.35 kW × 14 h × ₹9 = ₹44.10; owner pay ₹25 × 14 = ₹350
    // job cost ₹394.10; buffer 12% = ₹47.30 (47.292 rounded up) → ₹441.40
    // fee 25% = ₹110.35 → ₹551.75 → rounded up to ₹552; fee line = ₹110.60
    expect(
      priceJob([{ gpuSeconds: 14 * 3600, watts: 350, tariffPaisePerKwh: 900, ownerRatePaisePerHr: DEFAULT_OWNER_RATE_PAISE_PER_HR }]),
    ).toEqual({
      ownerPayPaise: 35000,
      electricityPaise: 4410,
      ownerReceivesPaise: 39410,
      verificationBufferPaise: 4730,
      nightshiftFeePaise: 11060,
      totalPaise: 55200,
      gpuSeconds: 50400,
    });
  });
});

describe("all-in price per GPU-hour", () => {
  it("is ₹39.04 / ₹39.42 / ₹42.57 for the three PC classes at the defaults", () => {
    // RTX 4070: (₹3.15 + ₹25) = ₹28.15 → +12% = ₹31.53 (31.528 up) → +25% = ₹39.42 (39.4125 up)
    expect(allInPerGpuHourPaise(350, 900, 2500)).toBe(3942);
    expect(allInPerGpuHourPaise(320, 900, 2500)).toBe(3904);
    expect(allInPerGpuHourPaise(600, 900, 2500)).toBe(4257);
  });

  it("validates its inputs like priceJob", () => {
    expect(() => allInPerGpuHourPaise(350, 900, -1)).toThrow(PricingInputError);
    expect(() => allInPerGpuHourPaise(0, 900, 2500)).toThrow(PricingInputError);
    expect(() => allInPerGpuHourPaise(350, 900, 2500, { feeBps: 10_001 })).toThrow(PricingInputError);
  });

  it("a whole-hour job costs hours × the per-hour price, rounded up to the rupee (within a few paise)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 720 }),
        fc.integer({ min: 1, max: LIMITS.maxWatts }),
        fc.integer({ min: 1, max: LIMITS.maxTariffPaisePerKwh }),
        fc.integer({ min: 0, max: LIMITS.maxOwnerRatePaisePerHr }),
        (hours, watts, tariff, rate) => {
          const perHour = allInPerGpuHourPaise(watts, tariff, rate);
          const total = priceJob([{ gpuSeconds: hours * 3600, watts, tariffPaisePerKwh: tariff, ownerRatePaisePerHr: rate }]).totalPaise;
          // Per-hour rounds up once per hour, the job rounds up once overall,
          // so the job is never more than ₹1 above hours × per-hour, and
          // never below it by more than the per-hour round-ups (< 4 paise/hr).
          expect(total).toBeLessThanOrEqual(hours * perHour + 100);
          expect(total).toBeGreaterThanOrEqual(hours * perHour - 4 * hours);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
