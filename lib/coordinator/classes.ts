import { DEFAULT_WATTS } from "@/lib/pricing";
import { BASELINE_BENCHMARK_SCORE } from "@/lib/timebank";

/**
 * Node classes the coordinator schedules on. The three GPU classes match the
 * pricing page. "cpu" is the demo fallback for laptops without an NVIDIA GPU.
 *
 * `defaultBenchmark` is used until the agent benchmarks the machine (phase 4).
 * Scale: an RTX 3060 = 1000 (lib/timebank.ts). These are conservative
 * estimates for the two small whitelisted models, not marketing numbers.
 */
export const NODE_CLASSES = ["rtx3060", "rtx4070", "rtx4090", "cpu"] as const;
export type NodeClass = (typeof NODE_CLASSES)[number];

export interface ClassSpec {
  label: string;
  defaultWatts: number;
  defaultBenchmark: number;
}

export const CLASS_SPECS: Readonly<Record<NodeClass, ClassSpec>> = Object.freeze({
  rtx3060: { label: "RTX 3060 PC", defaultWatts: DEFAULT_WATTS.rtx3060, defaultBenchmark: BASELINE_BENCHMARK_SCORE },
  rtx4070: { label: "RTX 4070 PC", defaultWatts: DEFAULT_WATTS.rtx4070, defaultBenchmark: 1600 },
  rtx4090: { label: "RTX 4090 PC", defaultWatts: DEFAULT_WATTS.rtx4090, defaultBenchmark: 3200 },
  // A laptop CPU running a small model: roughly 1/20 of an RTX 3060.
  cpu: { label: "Laptop, CPU only (demo)", defaultWatts: 65, defaultBenchmark: 50 },
});

/** Benchmark to plan with: the measured score once there is one. */
export function benchmarkFor(nodeClass: NodeClass, measured: number | null | undefined): number {
  return measured && measured > 0 ? measured : CLASS_SPECS[nodeClass].defaultBenchmark;
}

/** Watts to price with: measured once reported, else the class default. */
export function wattsFor(nodeClass: NodeClass, measured: number | null | undefined): number {
  return measured && measured > 0 ? measured : CLASS_SPECS[nodeClass].defaultWatts;
}
