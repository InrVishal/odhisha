/**
 * Time-Bank credit maths. Pure, no I/O.
 *
 * Credits are counted in STANDARD GPU-seconds: one second of work on the
 * baseline GPU, an RTX 3060. A node's work is weighted by its benchmark score
 * relative to that baseline, so faster GPUs earn more per hour, and cost more
 * per hour when you spend credits on them.
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

/** Benchmark used for weighting: at least 1, at most MAX_BENCHMARK_SCORE. */
export function effectiveBenchmark(benchmarkScore: number): number {
  checkInt("benchmarkScore", benchmarkScore, 0, Number.MAX_SAFE_INTEGER);
  return Math.min(Math.max(benchmarkScore, 1), MAX_BENCHMARK_SCORE);
}

/** Standard GPU-seconds earned for work done on a node. Rounded down. */
export function earnedStandardSeconds(gpuSeconds: number, benchmarkScore: number): number {
  checkInt("gpuSeconds", gpuSeconds, 0, MAX_GPU_SECONDS);
  return Math.floor((gpuSeconds * effectiveBenchmark(benchmarkScore)) / BASELINE_BENCHMARK_SCORE);
}

/** Standard GPU-seconds it costs to use a node for this long. Rounded up. */
export function costStandardSeconds(gpuSeconds: number, benchmarkScore: number): number {
  checkInt("gpuSeconds", gpuSeconds, 0, MAX_GPU_SECONDS);
  return Math.ceil((gpuSeconds * effectiveBenchmark(benchmarkScore)) / BASELINE_BENCHMARK_SCORE);
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
