import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BASELINE_BENCHMARK_SCORE,
  clusterCostStandardSeconds,
  costStandardSeconds,
  earnedStandardSeconds,
  effectiveBenchmark,
  formatStandardHours,
  MAX_BENCHMARK_SCORE,
  MAX_GPU_SECONDS,
  TimeBankInputError,
} from "@/lib/timebank";

const HOUR = 3600;

describe("weighting by benchmark, relative to an RTX 3060", () => {
  it("the baseline RTX 3060 earns 1 standard GPU-hour per hour", () => {
    expect(BASELINE_BENCHMARK_SCORE).toBe(1000);
    expect(earnedStandardSeconds(HOUR, 1000)).toBe(HOUR);
    // The copy's example: midnight to 6 AM on a hostel RTX 3060.
    expect(formatStandardHours(earnedStandardSeconds(6 * HOUR, 1000))).toBe("6 standard GPU-hours");
  });

  it("a GPU twice as fast earns twice as much", () => {
    expect(earnedStandardSeconds(HOUR, 2000)).toBe(2 * HOUR);
    expect(earnedStandardSeconds(HOUR, 3150)).toBe(3.15 * HOUR);
  });

  it("a slower GPU earns less", () => {
    expect(earnedStandardSeconds(HOUR, 500)).toBe(HOUR / 2);
    expect(earnedStandardSeconds(HOUR, 250)).toBe(900);
  });

  it("spending uses the same weights: 4 RTX 3060s for 3 hours cost 12 standard GPU-hours", () => {
    expect(clusterCostStandardSeconds([1000, 1000, 1000, 1000], 3 * HOUR)).toBe(12 * HOUR);
    expect(formatStandardHours(clusterCostStandardSeconds([1000, 1000, 1000, 1000], 3 * HOUR))).toBe("12 standard GPU-hours");
  });

  it("faster GPUs in a cluster cost more per hour", () => {
    expect(clusterCostStandardSeconds([1000, 2000], HOUR)).toBe(3 * HOUR);
  });
});

describe("rounding never creates credit", () => {
  it("earning rounds down and spending rounds up", () => {
    // 1 second at 1.5× = 1.5 standard seconds
    expect(earnedStandardSeconds(1, 1500)).toBe(1);
    expect(costStandardSeconds(1, 1500)).toBe(2);
  });

  const secondsArb = fc.integer({ min: 0, max: MAX_GPU_SECONDS });
  const scoreArb = fc.integer({ min: 1, max: MAX_BENCHMARK_SCORE });

  it("earned ≤ exact weighted time < earned + 1", () => {
    fc.assert(
      fc.property(secondsArb, scoreArb, (s, b) => {
        const earned = earnedStandardSeconds(s, b);
        const exactTimes1000 = s * b; // exact value × 1000
        expect(earned * 1000).toBeLessThanOrEqual(exactTimes1000);
        expect((earned + 1) * 1000).toBeGreaterThan(exactTimes1000);
      }),
      { numRuns: 2000 },
    );
  });

  it("using a node for as long as it worked never costs less than it earned", () => {
    fc.assert(
      fc.property(secondsArb, scoreArb, (s, b) => {
        const cost = costStandardSeconds(s, b);
        const earned = earnedStandardSeconds(s, b);
        expect(cost).toBeGreaterThanOrEqual(earned);
        expect(cost - earned).toBeLessThanOrEqual(1);
      }),
      { numRuns: 2000 },
    );
  });

  it("splitting work into pieces never earns more than doing it in one go", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 50 }), scoreArb, (pieces, b) => {
        const split = pieces.reduce((sum, s) => sum + earnedStandardSeconds(s, b), 0);
        const whole = earnedStandardSeconds(pieces.reduce((a, c) => a + c, 0), b);
        expect(split).toBeLessThanOrEqual(whole);
      }),
      { numRuns: 1000 },
    );
  });

  it("a faster benchmark never earns less", () => {
    fc.assert(
      fc.property(secondsArb, scoreArb, scoreArb, (s, b1, b2) => {
        const [lo, hi] = b1 <= b2 ? [b1, b2] : [b2, b1];
        expect(earnedStandardSeconds(s, hi)).toBeGreaterThanOrEqual(earnedStandardSeconds(s, lo));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("limits", () => {
  it("caps the weight at 10× an RTX 3060, so an inflated benchmark can't mint unlimited credit", () => {
    expect(effectiveBenchmark(1_000_000)).toBe(MAX_BENCHMARK_SCORE);
    expect(earnedStandardSeconds(HOUR, 1_000_000)).toBe(10 * HOUR);
  });

  it("treats a zero benchmark as the minimum weight, not as zero or an error", () => {
    expect(effectiveBenchmark(0)).toBe(1);
    expect(earnedStandardSeconds(HOUR, 0)).toBe(3); // 3600 × 1/1000, rounded down
  });

  it.each([
    ["negative seconds", () => earnedStandardSeconds(-1, 1000)],
    ["fractional seconds", () => earnedStandardSeconds(1.5, 1000)],
    ["too many seconds", () => costStandardSeconds(MAX_GPU_SECONDS + 1, 1000)],
    ["negative benchmark", () => earnedStandardSeconds(10, -5)],
    ["NaN benchmark", () => costStandardSeconds(10, Number.NaN)],
    ["empty cluster", () => clusterCostStandardSeconds([], HOUR)],
    ["cluster too big", () => clusterCostStandardSeconds(Array.from({ length: 65 }, () => 1000), HOUR)],
    ["negative format", () => formatStandardHours(-1)],
  ])("rejects %s", (_name, fn) => {
    expect(fn).toThrow(TimeBankInputError);
  });

  it("formats hours readably", () => {
    expect(formatStandardHours(3600)).toBe("1 standard GPU-hour");
    expect(formatStandardHours(5400)).toBe("1.5 standard GPU-hours");
    expect(formatStandardHours(4500)).toBe("1.25 standard GPU-hours");
    expect(formatStandardHours(0)).toBe("0 standard GPU-hours");
  });
});
