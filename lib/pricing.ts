/**
 * NightShift pricing. A pure function with no I/O, shared by the server
 * (quotes) and the browser (pricing calculator).
 *
 * The brief's formula:
 *   power_cost_per_hr = node_kw × tariff_per_kwh
 *   base_per_hr       = power_cost_per_hr + owner_rate_per_hr
 *   job_cost          = Σ over fragments (gpu_hours × base_per_hr)
 *   job_cost_buffered = job_cost × (1 + verification_buffer)
 *   platform_fee      = job_cost_buffered × fee_rate
 *   price             = round_up_to_rupee(job_cost_buffered + platform_fee)
 *
 * Money is integer paise. Intermediate products are exact BigInt
 * rationals, and every rounding step rounds UP, in the owner's favour first:
 * - electricity is rounded up to the paisa, so the owner is never paid less
 *   than their real power cost;
 * - the buffer and the fee are rounded up to the paisa;
 * - the final total is rounded up to the rupee, and that rounding goes to
 *   the NightShift fee line, so the breakdown lines always add up to the
 *   total exactly. No paisa is created or lost.
 */

export type GpuClass = "rtx3060" | "rtx4070" | "rtx4090";

/** Default whole-PC draw while working, until the agent reports real watts. */
export const DEFAULT_WATTS: Readonly<Record<GpuClass, number>> = Object.freeze({
  rtx3060: 320,
  rtx4070: 350,
  rtx4090: 600,
});

export const GPU_LABELS: Readonly<Record<GpuClass, string>> = Object.freeze({
  rtx3060: "RTX 3060 PC",
  rtx4070: "RTX 4070 PC",
  rtx4090: "RTX 4090 PC",
});

/** ₹9 per kWh, in paise. Owners can set their own tariff. */
export const DEFAULT_TARIFF_PAISE_PER_KWH = 900;

/** 12% verification buffer and 25% platform fee, in basis points. */
export const DEFAULT_VERIFICATION_BUFFER_BPS = 1200;
export const DEFAULT_FEE_BPS = 2500;

/**
 * Default owner rate: ₹25 per GPU-hour, on top of electricity. New nodes
 * start here (DB default in migration 0002) and owners can change it. Not a
 * promise of earnings: owners only earn when there are jobs.
 */
export const DEFAULT_OWNER_RATE_PAISE_PER_HR = 2500;

export interface FragmentPricingInput {
  /** GPU time for this fragment, in whole seconds. */
  gpuSeconds: number;
  /** Measured watts if the node has reported them, else the class default. */
  watts: number;
  tariffPaisePerKwh: number;
  ownerRatePaisePerHr: number;
}

export interface PricingOptions {
  verificationBufferBps?: number;
  feeBps?: number;
}

export interface PriceBreakdown {
  /** The owners' hourly rate × hours. Paid to owners. */
  ownerPayPaise: number;
  /** Power cost, paid to owners on top of their rate. Rounded up. */
  electricityPaise: number;
  /** What owners receive in total: ownerPay + electricity. */
  ownerReceivesPaise: number;
  /** Covers re-running ~10% of fragments on a second machine to check them. */
  verificationBufferPaise: number;
  /** NightShift's fee, including the round-up to the next rupee. */
  nightshiftFeePaise: number;
  /** What the buyer pays. Always a whole number of rupees. */
  totalPaise: number;
  /** Sum of GPU time across fragments, in seconds. */
  gpuSeconds: number;
}

export class PricingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingInputError";
  }
}

const SECONDS_PER_HOUR = 3600n;
const WATTS_PER_KW = 1000n;
const BPS = 10_000n;

/** ceil(a / b) for non-negative BigInts. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function checkInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    throw new PricingInputError(`${name} must be a whole number from ${min} to ${max}`);
  }
}

/** Upper bounds keep every result far inside Number.MAX_SAFE_INTEGER. */
export const LIMITS = Object.freeze({
  maxFragments: 100_000,
  maxGpuSecondsPerFragment: 30 * 24 * 3600,
  maxWatts: 5_000,
  maxTariffPaisePerKwh: 10_000,
  maxOwnerRatePaisePerHr: 1_000_000,
  maxBps: 10_000,
});

function toNumber(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new PricingInputError("price is out of range");
  return n;
}

export function priceJob(fragments: readonly FragmentPricingInput[], options: PricingOptions = {}): PriceBreakdown {
  const bufferBps = options.verificationBufferBps ?? DEFAULT_VERIFICATION_BUFFER_BPS;
  const feeBps = options.feeBps ?? DEFAULT_FEE_BPS;
  checkInt("verificationBufferBps", bufferBps, 0, LIMITS.maxBps);
  checkInt("feeBps", feeBps, 0, LIMITS.maxBps);
  if (fragments.length === 0) throw new PricingInputError("a job needs at least one fragment");
  if (fragments.length > LIMITS.maxFragments) throw new PricingInputError("too many fragments");

  // Exact numerators. electricity paise = Σ W·s·tariff / (1000·3600);
  // owner pay paise = Σ rate·s / 3600.
  let electricityNum = 0n;
  let ownerPayNum = 0n;
  let gpuSeconds = 0n;
  for (const f of fragments) {
    checkInt("gpuSeconds", f.gpuSeconds, 1, LIMITS.maxGpuSecondsPerFragment);
    checkInt("watts", f.watts, 1, LIMITS.maxWatts);
    checkInt("tariffPaisePerKwh", f.tariffPaisePerKwh, 1, LIMITS.maxTariffPaisePerKwh);
    checkInt("ownerRatePaisePerHr", f.ownerRatePaisePerHr, 0, LIMITS.maxOwnerRatePaisePerHr);
    const s = BigInt(f.gpuSeconds);
    electricityNum += BigInt(f.watts) * s * BigInt(f.tariffPaisePerKwh);
    ownerPayNum += BigInt(f.ownerRatePaisePerHr) * s;
    gpuSeconds += s;
  }

  const electricity = ceilDiv(electricityNum, WATTS_PER_KW * SECONDS_PER_HOUR);
  const ownerPay = ceilDiv(ownerPayNum, SECONDS_PER_HOUR);
  const jobCost = electricity + ownerPay;
  const buffer = ceilDiv(jobCost * BigInt(bufferBps), BPS);
  const buffered = jobCost + buffer;
  const feeBeforeRounding = ceilDiv(buffered * BigInt(feeBps), BPS);
  const total = ceilDiv(buffered + feeBeforeRounding, 100n) * 100n;
  const fee = total - buffered;

  return {
    ownerPayPaise: toNumber(ownerPay),
    electricityPaise: toNumber(electricity),
    ownerReceivesPaise: toNumber(jobCost),
    verificationBufferPaise: toNumber(buffer),
    nightshiftFeePaise: toNumber(fee),
    totalPaise: toNumber(total),
    gpuSeconds: toNumber(gpuSeconds),
  };
}

/**
 * All-in price of one GPU-hour, in paise: electricity + owner rate, plus the
 * verification buffer, plus the fee, each rounded up to the paisa exactly as
 * priceJob does. It leaves out only the job-level round-up to the next rupee,
 * so a job of N hours costs N × this, rounded up (within a few paise).
 */
export function allInPerGpuHourPaise(
  watts: number,
  tariffPaisePerKwh: number,
  ownerRatePaisePerHr: number,
  options: PricingOptions = {},
): number {
  const bufferBps = options.verificationBufferBps ?? DEFAULT_VERIFICATION_BUFFER_BPS;
  const feeBps = options.feeBps ?? DEFAULT_FEE_BPS;
  checkInt("verificationBufferBps", bufferBps, 0, LIMITS.maxBps);
  checkInt("feeBps", feeBps, 0, LIMITS.maxBps);
  checkInt("ownerRatePaisePerHr", ownerRatePaisePerHr, 0, LIMITS.maxOwnerRatePaisePerHr);
  const cost = BigInt(powerCostPerHourPaise(watts, tariffPaisePerKwh) + ownerRatePaisePerHr);
  const buffered = cost + ceilDiv(cost * BigInt(bufferBps), BPS);
  return toNumber(buffered + ceilDiv(buffered * BigInt(feeBps), BPS));
}

/** Electricity cost of one hour of work, in paise (exact, rounded up). */
export function powerCostPerHourPaise(watts: number, tariffPaisePerKwh: number): number {
  checkInt("watts", watts, 1, LIMITS.maxWatts);
  checkInt("tariffPaisePerKwh", tariffPaisePerKwh, 1, LIMITS.maxTariffPaisePerKwh);
  return toNumber(ceilDiv(BigInt(watts) * BigInt(tariffPaisePerKwh), WATTS_PER_KW));
}

// ─── Parsing and formatting (string math, no floats) ───────────────────────

/** "9" → 900, "9.5" → 950, "3.15" → 315. Up to 2 decimal places. */
export function parseRupeesToPaise(input: string): number | null {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** "2" → 7200, "2.5" → 9000, "0.25" → 900. Up to 4 decimal places, rounded up to a second. */
export function parseHoursToSeconds(input: string): number | null {
  const m = /^\s*(\d{1,5})(?:\.(\d{1,4}))?\s*$/.exec(input);
  if (!m) return null;
  const frac = BigInt((m[2] ?? "").padEnd(4, "0"));
  const seconds = BigInt(m[1]!) * 3600n + ceilDiv(frac * 3600n, 10_000n);
  return Number(seconds);
}

const inr = new Intl.NumberFormat("en-IN");

/** 34000 → "₹340", 315 → "₹3.15", 12345600 → "₹1,23,456". */
export function formatPaise(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new PricingInputError("paise must be an integer");
  const sign = paise < 0 ? "−" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}₹${inr.format(rupees)}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}
