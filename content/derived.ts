import {
  DEFAULT_TARIFF_PAISE_PER_KWH,
  DEFAULT_WATTS,
  EXAMPLE_OWNER_RATE_PAISE_PER_HR,
  formatPaise,
  powerCostPerHourPaise,
  priceJob,
} from "@/lib/pricing";

/**
 * Numbers in the copy that come from the pricing engine. Computed, never
 * typed by hand, so the site can't disagree with the maths.
 */

export const SAMPLE_QUOTE_HOURS = 10;
export const SAMPLE_QUOTE_FINISH = "6:00 AM";

const sample = priceJob([
  {
    gpuSeconds: SAMPLE_QUOTE_HOURS * 3600,
    watts: DEFAULT_WATTS.rtx4070,
    tariffPaisePerKwh: DEFAULT_TARIFF_PAISE_PER_KWH,
    ownerRatePaisePerHr: EXAMPLE_OWNER_RATE_PAISE_PER_HR.rtx4070,
  },
]);

export const copyValues: Record<string, string> = {
  sampleQuote: `${SAMPLE_QUOTE_HOURS} GPU-hours on RTX 4070 PCs at an example owner rate of ${formatPaise(
    EXAMPLE_OWNER_RATE_PAISE_PER_HR.rtx4070,
  )} an hour comes to ${formatPaise(sample.totalPaise)}, done by ${SAMPLE_QUOTE_FINISH}`,
  power3060: formatPaise(powerCostPerHourPaise(DEFAULT_WATTS.rtx3060, DEFAULT_TARIFF_PAISE_PER_KWH)),
  power4070: formatPaise(powerCostPerHourPaise(DEFAULT_WATTS.rtx4070, DEFAULT_TARIFF_PAISE_PER_KWH)),
  power4090: formatPaise(powerCostPerHourPaise(DEFAULT_WATTS.rtx4090, DEFAULT_TARIFF_PAISE_PER_KWH)),
};

/** Replaces {name} with a value. Unknown names throw, so typos fail the build. */
export function fill(text: string, values: Record<string, string> = copyValues): string {
  return text.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`copy placeholder {${key}} has no value`);
    return v;
  });
}
