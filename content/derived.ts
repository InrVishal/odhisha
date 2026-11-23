import {
  allInPerGpuHourPaise,
  DEFAULT_OWNER_RATE_PAISE_PER_HR,
  DEFAULT_TARIFF_PAISE_PER_KWH,
  DEFAULT_WATTS,
  formatPaise,
  powerCostPerHourPaise,
  priceJob,
  MIN_JOB_PRICE_PAISE,
} from "@/lib/pricing";
import { BASELINE_BENCHMARK_SCORE, clusterCostStandardSeconds, earnedStandardSeconds, formatStandardHours } from "@/lib/timebank";

/**
 * Numbers in the copy that come from the pricing and Time-Bank engines.
 * Computed, never typed by hand, so the site can't disagree with the maths.
 */

/** The worked example used across the site (matches the pitch deck). */
export const SAMPLE_QUOTE_HOURS = 14;
export const SAMPLE_QUOTE_FINISH = "6:00 AM";

export const sampleQuote = priceJob([
  {
    gpuSeconds: SAMPLE_QUOTE_HOURS * 3600,
    watts: DEFAULT_WATTS.rtx4070,
    tariffPaisePerKwh: DEFAULT_TARIFF_PAISE_PER_KWH,
    ownerRatePaisePerHr: DEFAULT_OWNER_RATE_PAISE_PER_HR,
  },
]);

const HOUR = 3600;

export const copyValues: Record<string, string> = {
  defaultRate: formatPaise(DEFAULT_OWNER_RATE_PAISE_PER_HR),
  minJob: formatPaise(MIN_JOB_PRICE_PAISE),
  sampleQuote: `${SAMPLE_QUOTE_HOURS} GPU-hours on RTX 4070 PCs at our default owner rate of ${formatPaise(
    DEFAULT_OWNER_RATE_PAISE_PER_HR,
  )} an hour comes to ${formatPaise(sampleQuote.totalPaise)}, done by ${SAMPLE_QUOTE_FINISH}`,
  sample14Total: formatPaise(sampleQuote.totalPaise),
  power3060: formatPaise(powerCostPerHourPaise(DEFAULT_WATTS.rtx3060, DEFAULT_TARIFF_PAISE_PER_KWH)),
  power4070: formatPaise(powerCostPerHourPaise(DEFAULT_WATTS.rtx4070, DEFAULT_TARIFF_PAISE_PER_KWH)),
  power4090: formatPaise(powerCostPerHourPaise(DEFAULT_WATTS.rtx4090, DEFAULT_TARIFF_PAISE_PER_KWH)),
  perHour3060: formatPaise(allInPerGpuHourPaise(DEFAULT_WATTS.rtx3060, DEFAULT_TARIFF_PAISE_PER_KWH, DEFAULT_OWNER_RATE_PAISE_PER_HR)),
  perHour4070: formatPaise(allInPerGpuHourPaise(DEFAULT_WATTS.rtx4070, DEFAULT_TARIFF_PAISE_PER_KWH, DEFAULT_OWNER_RATE_PAISE_PER_HR)),
  perHour4090: formatPaise(allInPerGpuHourPaise(DEFAULT_WATTS.rtx4090, DEFAULT_TARIFF_PAISE_PER_KWH, DEFAULT_OWNER_RATE_PAISE_PER_HR)),
  tbDouble: formatStandardHours(earnedStandardSeconds(HOUR, 2 * BASELINE_BENCHMARK_SCORE)),
  tbHostel: formatStandardHours(earnedStandardSeconds(6 * HOUR, BASELINE_BENCHMARK_SCORE)),
  tbCluster: formatStandardHours(clusterCostStandardSeconds(Array(4).fill(BASELINE_BENCHMARK_SCORE), 3 * HOUR)),
};

/** Replaces {name} with a value. Unknown names throw, so typos fail the build. */
export function fill(text: string, values: Record<string, string> = copyValues): string {
  return text.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`copy placeholder {${key}} has no value`);
    return v;
  });
}
