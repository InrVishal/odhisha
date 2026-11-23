import { DEFAULT_OWNER_RATE_PAISE_PER_HR, DEFAULT_TARIFF_PAISE_PER_KWH, DEFAULT_WATTS, powerCostPerHourPaise, type GpuClass } from "@/lib/pricing";

/**
 * GPU-on-EMI simulator. DEMO MODE ONLY: NightShift doesn't lend money,
 * arrange loans or promise work. Pure, no I/O.
 *
 * Money is integer paise. The EMI itself needs a power, so it's worked out in
 * floating point once and rounded UP to the paisa; everything after that
 * (interest, the schedule, earnings) is whole-number maths.
 *
 * Earnings: an owner is paid their rate plus their electricity for every
 * GPU-hour of work. The electricity part only covers the power bill, so it is
 * taken out first: what's left for the EMI is the owner rate × hours worked.
 */

/** Example shop prices, for the form's starting value. The owner types their own. */
export const EXAMPLE_GPU_PRICE_PAISE: Readonly<Record<GpuClass, number>> = Object.freeze({
  rtx3060: 2_600_000,
  rtx4070: 5_500_000,
  rtx4090: 16_500_000,
});

export const EMI_DEFAULTS = Object.freeze({
  annualRateBps: 1500,
  months: 12,
  hoursPerNight: 8,
  nightsPerMonth: 30,
  /** Share of night hours with work. Not a promise: there may be no jobs. */
  utilisationPct: 50,
  ownerRatePaisePerHr: DEFAULT_OWNER_RATE_PAISE_PER_HR,
  tariffPaisePerKwh: DEFAULT_TARIFF_PAISE_PER_KWH,
});

/** Payoff beyond this many months is shown as "not within 10 years". */
export const MAX_PAYOFF_MONTHS = 120;

export class EmiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmiInputError";
  }
}

function checkInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new EmiInputError(`${name} must be a whole number from ${min} to ${max}`);
}

/**
 * Monthly instalment for a loan of `principalPaise` at `annualRateBps`
 * (1500 = 15% a year) over `months`, rounded up to the paisa.
 * EMI = P·r·(1+r)^n / ((1+r)^n − 1), r = annual rate / 12; P / n at 0%.
 */
export function emiPaise(principalPaise: number, annualRateBps: number, months: number): number {
  checkInt("principalPaise", principalPaise, 0, 1_000_000_000);
  checkInt("annualRateBps", annualRateBps, 0, 6000);
  checkInt("months", months, 1, 60);
  if (principalPaise === 0) return 0;
  if (annualRateBps === 0) return Math.ceil(principalPaise / months);
  const r = annualRateBps / 120_000;
  const f = (1 + r) ** months;
  // Tiny epsilon so a float a hair above a whole paisa doesn't round up twice.
  return Math.ceil((principalPaise * r * f) / (f - 1) - 1e-7);
}

/** One month's interest on a balance, rounded half up to the paisa. */
export function monthInterestPaise(balancePaise: number, annualRateBps: number): number {
  return Math.floor((balancePaise * annualRateBps + 60_000) / 120_000);
}

export interface EarningsInput {
  gpuClass: GpuClass;
  hoursPerNight: number;
  nightsPerMonth: number;
  utilisationPct: number;
  ownerRatePaisePerHr: number;
  tariffPaisePerKwh: number;
  /** Whole-PC draw while working. Defaults to the class default. */
  watts?: number;
}

export interface MonthlyEarnings {
  /** Hours of work a month (night hours × utilisation). */
  workSeconds: number;
  /** What NightShift would pay: owner rate + electricity, per hour worked. */
  grossPaise: number;
  /** The power bill for those hours, at the owner's tariff. */
  electricityPaise: number;
  /** gross − electricity: what's left for the EMI. */
  netPaise: number;
}

export function monthlyEarnings(e: EarningsInput): MonthlyEarnings {
  checkInt("hoursPerNight", e.hoursPerNight, 0, 16);
  checkInt("nightsPerMonth", e.nightsPerMonth, 0, 31);
  checkInt("utilisationPct", e.utilisationPct, 0, 100);
  checkInt("ownerRatePaisePerHr", e.ownerRatePaisePerHr, 0, 100_000);
  const watts = e.watts ?? DEFAULT_WATTS[e.gpuClass];
  const powerPerHour = powerCostPerHourPaise(watts, e.tariffPaisePerKwh);
  const workSeconds = Math.floor((e.hoursPerNight * 3600 * e.nightsPerMonth * e.utilisationPct) / 100);
  // Pay is rounded down and the bill up, so the projection never flatters.
  const grossPaise = Math.floor(((e.ownerRatePaisePerHr + powerPerHour) * workSeconds) / 3600);
  const electricityPaise = Math.ceil((powerPerHour * workSeconds) / 3600);
  return { workSeconds, grossPaise, electricityPaise, netPaise: Math.max(0, grossPaise - electricityPaise) };
}

export interface EmiInput extends EarningsInput {
  pricePaise: number;
  downPaymentPaise: number;
  annualRateBps: number;
  months: number;
}

export interface EmiMonth {
  month: number;
  emiPaise: number;
  interestPaise: number;
  principalPaise: number;
  /** Loan left after this month's payment. */
  balancePaise: number;
  /** Paid from network earnings (net of electricity) / from the owner's pocket. */
  fromEarningsPaise: number;
  fromPocketPaise: number;
}

export interface EmiResult {
  loanPaise: number;
  emiPaise: number;
  totalInterestPaise: number;
  /** Down payment + every instalment. */
  totalCostPaise: number;
  earnings: MonthlyEarnings;
  /** Share of each EMI the net earnings cover, whole percent (can exceed 100). */
  coveredPct: number;
  /** Months of net earnings to cover the GPU's whole cost (down payment + interest). Null: not within 10 years. */
  monthsToPayoff: number | null;
  schedule: EmiMonth[];
  demo: true;
}

export function simulateEmi(input: EmiInput): EmiResult {
  checkInt("pricePaise", input.pricePaise, 0, 1_000_000_000);
  checkInt("downPaymentPaise", input.downPaymentPaise, 0, input.pricePaise);
  const loan = input.pricePaise - input.downPaymentPaise;
  const emi = emiPaise(loan, input.annualRateBps, input.months);
  const earnings = monthlyEarnings(input);

  const schedule: EmiMonth[] = [];
  let balance = loan;
  let interestTotal = 0;
  for (let month = 1; month <= input.months && balance > 0; month++) {
    const interest = monthInterestPaise(balance, input.annualRateBps);
    // The last instalment is whatever is left, so the loan ends at exactly 0.
    const due = month === input.months || balance + interest <= emi ? balance + interest : emi;
    const principal = due - interest;
    balance -= principal;
    interestTotal += interest;
    const fromEarnings = Math.min(earnings.netPaise, due);
    schedule.push({ month, emiPaise: due, interestPaise: interest, principalPaise: principal, balancePaise: balance, fromEarningsPaise: fromEarnings, fromPocketPaise: due - fromEarnings });
  }
  const totalCost = input.downPaymentPaise + schedule.reduce((s, m) => s + m.emiPaise, 0);
  const payoff = earnings.netPaise > 0 ? Math.ceil(totalCost / earnings.netPaise) : null;
  return {
    loanPaise: loan,
    emiPaise: emi,
    totalInterestPaise: interestTotal,
    totalCostPaise: totalCost,
    earnings,
    coveredPct: emi > 0 ? Math.floor((earnings.netPaise * 100) / emi) : 0,
    monthsToPayoff: payoff !== null && payoff <= MAX_PAYOFF_MONTHS ? payoff : null,
    schedule,
    demo: true,
  };
}
