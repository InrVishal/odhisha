import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BASELINE_BENCHMARK_SCORE,
  clusterCostStandardSeconds,
  costStandardSeconds,
  CREDIT_WEIGHTING_FROZEN,
  creditCost,
  creditWeightScore,
  earnedStandardSeconds,
  effectiveBenchmark,
  formatCredits,
  formatStandardHours,
  MAX_BENCHMARK_SCORE,
  MAX_GPU_SECONDS,
  TimeBankInputError,
} from "@/lib/timebank";

const HOUR = 3600;

describe("weighting is frozen at 1.0× until speed scores are calibrated", () => {
  it("is frozen", () => {
    expect(CREDIT_WEIGHTING_FROZEN).toBe(true);
  });

  it("every PC earns one standard GPU-hour per verified hour, however fast it is (or claims to be)", () => {
    expect(BASELINE_BENCHMARK_SCORE).toBe(1000);
    for (const score of [0, 1, 33, 500, 1000, 2000, 3150, MAX_BENCHMARK_SCORE, 1_000_000]) {
      expect(earnedStandardSeconds(HOUR, score)).toBe(HOUR);
      expect(costStandardSeconds(HOUR, score)).toBe(HOUR);
      expect(creditWeightScore(score)).toBe(BASELINE_BENCHMARK_SCORE);
    }
    // The copy's example: midnight to 6 AM.
    expect(formatStandardHours(earnedStandardSeconds(6 * HOUR, 1000))).toBe("6 standard GPU-hours");
  });

  it("property: earned = GPU-seconds, for any speed score", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_GPU_SECONDS }), fc.integer({ min: 0, max: 10 * MAX_BENCHMARK_SCORE }), (s, b) => {
        expect(earnedStandardSeconds(s, b)).toBe(s);
        expect(costStandardSeconds(s, b)).toBe(s);
      }),
      { numRuns: 2000 },
    );
  });

  it("a cluster costs GPUs × hours", () => {
    expect(clusterCostStandardSeconds([1000, 1000, 1000, 1000], 3 * HOUR)).toBe(12 * HOUR);
    expect(clusterCostStandardSeconds([500, 4000], HOUR)).toBe(2 * HOUR);
  });

  it("the weight cap still applies to the score itself (used again once unfrozen)", () => {
    expect(effectiveBenchmark(1_000_000)).toBe(MAX_BENCHMARK_SCORE);
    expect(effectiveBenchmark(0)).toBe(1);
  });
});

describe("what a job costs in credits", () => {
  it("its GPU-seconds plus the 12% verification buffer, rounded up", () => {
    expect(creditCost([12 * HOUR])).toBe(48_384);
    expect(formatStandardHours(creditCost([4 * 3 * HOUR]))).toBe("13.44 standard GPU-hours");
    expect(creditCost([1])).toBe(2);
    expect(creditCost([100, 200, 300])).toBe(672);
  });

  it("property: never less than the work it buys, never more than 12% + 1 second over", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 40 }), (pieces) => {
        const total = pieces.reduce((a, b) => a + b, 0);
        const cost = creditCost(pieces);
        expect(cost).toBeGreaterThanOrEqual(total);
        expect(cost).toBeLessThanOrEqual(Math.ceil(total * 1.12) + 1);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("rounding never creates credit", () => {
  it("splitting work into pieces never earns more than doing it in one go", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 50 }),
        fc.integer({ min: 1, max: MAX_BENCHMARK_SCORE }),
        (pieces, b) => {
          const split = pieces.reduce((sum, s) => sum + earnedStandardSeconds(s, b), 0);
          const whole = earnedStandardSeconds(pieces.reduce((a, c) => a + c, 0), b);
          expect(split).toBeLessThanOrEqual(whole);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("limits", () => {
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

  it("formats small balances without rounding them to 0", () => {
    expect(formatCredits(0)).toBe("0 standard GPU-hours");
    expect(formatCredits(1)).toBe("1 standard GPU-second");
    expect(formatCredits(31)).toBe("31 standard GPU-seconds");
    expect(formatCredits(60)).toBe("1 standard GPU-minute");
    expect(formatCredits(754)).toBe("12 standard GPU-minutes");
    expect(formatCredits(5400)).toBe("1.5 standard GPU-hours");
  });

  it("formats hours readably", () => {
    expect(formatStandardHours(3600)).toBe("1 standard GPU-hour");
    expect(formatStandardHours(5400)).toBe("1.5 standard GPU-hours");
    expect(formatStandardHours(4500)).toBe("1.25 standard GPU-hours");
    expect(formatStandardHours(0)).toBe("0 standard GPU-hours");
  });
});
