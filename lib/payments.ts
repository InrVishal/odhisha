/**
 * Payments and payouts, behind interfaces so a real provider (Razorpay test
 * mode for charges, RazorpayX for UPI payouts) can be plugged in later.
 *
 * DEMO MODE: the only implementation here is simulated. No money moves, no
 * card or UPI details are ever collected, and every reference it returns
 * starts with "demo_". The UI labels all of it "demo mode".
 */

export interface ChargeRequest {
  buyerId: string;
  jobId: string;
  amountPaise: number;
  /** Same key → same result, never a second charge. */
  idempotencyKey: string;
}

export interface RefundRequest {
  buyerId: string;
  jobId: string;
  amountPaise: number;
  reason: "deadline_missed" | "job_failed";
  idempotencyKey: string;
}

export interface PayoutRequest {
  ownerId: string;
  amountPaise: number;
  idempotencyKey: string;
}

export interface ProviderResult {
  ok: boolean;
  reference: string;
  demo: boolean;
}

export interface PaymentProvider {
  readonly name: string;
  readonly demo: boolean;
  charge(req: ChargeRequest): Promise<ProviderResult>;
  refund(req: RefundRequest): Promise<ProviderResult>;
}

export interface PayoutProvider {
  readonly name: string;
  readonly demo: boolean;
  payout(req: PayoutRequest): Promise<ProviderResult>;
}

/** Always succeeds, moves nothing. The reference is derived from the idempotency key. */
export class DemoPayments implements PaymentProvider, PayoutProvider {
  readonly name = "demo";
  readonly demo = true;

  async charge(req: ChargeRequest): Promise<ProviderResult> {
    assertAmount(req.amountPaise);
    return { ok: true, reference: `demo_ch_${req.idempotencyKey}`, demo: true };
  }

  async refund(req: RefundRequest): Promise<ProviderResult> {
    assertAmount(req.amountPaise);
    return { ok: true, reference: `demo_rf_${req.idempotencyKey}`, demo: true };
  }

  async payout(req: PayoutRequest): Promise<ProviderResult> {
    assertAmount(req.amountPaise);
    return { ok: true, reference: `demo_po_${req.idempotencyKey}`, demo: true };
  }
}

function assertAmount(paise: number): void {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error("amount must be a non-negative whole number of paise");
}

let provider: PaymentProvider & PayoutProvider = new DemoPayments();

export function getPayments(): PaymentProvider & PayoutProvider {
  return provider;
}

/** Test helper: swap in a fake provider (e.g. one that fails). */
export function setPaymentsForTests(p: PaymentProvider & PayoutProvider): void {
  provider = p;
}
