import { DEFAULT_VERIFICATION_BUFFER_BPS } from "@/lib/pricing";

/**
 * Time-Bank credit maths. Pure, no I/O.
 *
 * Credits are counted in standard GPU-seconds. The plan is to weight a PC's
 * work by its speed score relative to an RTX 3060 (faster GPUs earn more per
 * hour). That weighting is FROZEN AT 1.0× (CREDIT_WEIGHTING_FROZEN) until the
 * speed scale is calibrated on a real RTX 3060 (docs/CALIBRATION.md): until
 * then every verified GPU-second earns one credit-second, whatever the PC.
 *
 * Benchmark scale: the agent's benchmark (phase 4) is normalised so that a
 * reference RTX 3060 scores BASELINE_BENCHMARK_SCORE (1000). A GPU twice as
 * fast scores 2000 and earns 2 standard GPU-hours per hour.
 *
 * Rounding never creates credit: earning rounds DOWN to the standard second,
 * spending rounds UP. Credits are not money and can't be cashed out; the
 * ledger stores them in `credit_ledger.amount_gpu_seconds` (standard seconds).
 */

export const BASELINE_BENCHMARK_SCORE = 1000;
export const BASELINE_GPU_LABEL = "RTX 3060";

/**
 * Weights are capped at 10× the baseline. Benchmarks are self-reported until
 * verification (phase 6) builds trust, so one inflated score can't mint
 * unlimited credit.
 */
export const MAX_WEIGHT_MULTIPLE = 10;
export const MAX_BENCHMARK_SCORE = BASELINE_BENCHMARK_SCORE * MAX_WEIGHT_MULTIPLE;

/** Up to 30 days of GPU time in one entry, far inside safe integers. */
export const MAX_GPU_SECONDS = 30 * 24 * 3600;

export class TimeBankInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeBankInputError";
  }
}

function checkInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    throw new TimeBankInputError(`${name} must be a whole number from ${min} to ${max}`);
  }
}

/** True until speed scores are calibrated: every PC earns and costs 1.0×. */
export const CREDIT_WEIGHTING_FROZEN = true;

/** The weight a PC's work gets, as a benchmark score (1000 = 1.0×). */
export function creditWeightScore(benchmarkScore: number): number {
  const b = effectiveBenchmark(benchmarkScore);
  return CREDIT_WEIGHTING_FROZEN ? BASELINE_BENCHMARK_SCORE : b;
}

/** Benchmark used for weighting: at least 1, at most MAX_BENCHMARK_SCORE. */
export function effectiveBenchmark(benchmarkScore: number): number {
  checkInt("benchmarkScore", benchmarkScore, 0, Number.MAX_SAFE_INTEGER);
  return Math.min(Math.max(benchmarkScore, 1), MAX_BENCHMARK_SCORE);
}

/** Standard GPU-seconds earned for work done on a node. Rounded down. */
export function earnedStandardSeconds(gpuSeconds: number, benchmarkScore: number): number {
  checkInt("gpuSeconds", gpuSeconds, 0, MAX_GPU_SECONDS);
  return Math.floor((gpuSeconds * creditWeightScore(benchmarkScore)) / BASELINE_BENCHMARK_SCORE);
}

/** Standard GPU-seconds it costs to use a node for this long. Rounded up. */
export function costStandardSeconds(gpuSeconds: number, benchmarkScore: number): number {
  checkInt("gpuSeconds", gpuSeconds, 0, MAX_GPU_SECONDS);
  return Math.ceil((gpuSeconds * creditWeightScore(benchmarkScore)) / BASELINE_BENCHMARK_SCORE);
}

/** Cost of a temporary cluster: every node for the same duration. */
export function clusterCostStandardSeconds(benchmarkScores: readonly number[], gpuSeconds: number): number {
  if (benchmarkScores.length === 0) throw new TimeBankInputError("a cluster needs at least one GPU");
  if (benchmarkScores.length > 64) throw new TimeBankInputError("a cluster can have at most 64 GPUs");
  return benchmarkScores.reduce((sum, b) => sum + costStandardSeconds(gpuSeconds, b), 0);
}

/** 21600 → "6 standard GPU-hours", 5400 → "1.5 standard GPU-hours". */
export function formatStandardHours(standardSeconds: number): string {
  checkInt("standardSeconds", standardSeconds, 0, Number.MAX_SAFE_INTEGER);
  const hundredths = Math.floor((standardSeconds * 100) / 3600);
  const whole = Math.floor(hundredths / 100);
  const frac = hundredths % 100;
  const num = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
  return `${num} standard GPU-hour${num === "1" ? "" : "s"}`;
}

/** Credits a job costs: its GPU-seconds plus the verification buffer, rounded up. */
export function creditCost(estGpuSeconds: readonly number[]): number {
  const total = estGpuSeconds.reduce((s, x) => s + x, 0);
  return Math.ceil((total * (10_000 + DEFAULT_VERIFICATION_BUFFER_BPS)) / 10_000);
}

/**
 * Credits for people: hours once there is at least one, otherwise minutes or
 * seconds, so a small balance never reads as "0". 31 → "31 standard
 * GPU-seconds", 754 → "12 standard GPU-minutes", 5400 → "1.5 standard GPU-hours".
 */
export function formatCredits(standardSeconds: number): string {
  checkInt("standardSeconds", standardSeconds, 0, Number.MAX_SAFE_INTEGER);
  if (standardSeconds >= 3600 || standardSeconds === 0) return formatStandardHours(standardSeconds);
  if (standardSeconds >= 60) {
    const m = Math.floor(standardSeconds / 60);
    return `${m} standard GPU-minute${m === 1 ? "" : "s"}`;
  }
  return `${standardSeconds} standard GPU-second${standardSeconds === 1 ? "" : "s"}`;
}
