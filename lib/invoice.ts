import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { CLASS_SPECS, type NodeClass } from "@/lib/coordinator/classes";
import { CoordinatorError, notFound } from "@/lib/coordinator/errors";
import type { QuoteBreakdown } from "@/lib/coordinator/jobs";
import { WORKLOADS, type WorkloadType } from "@/lib/coordinator/workloads";
import type { Db } from "@/lib/db/client";
import { buyerLedger, jobs, users } from "@/lib/db/schema";
import { renderPdf, type PdfLine, type PdfText } from "@/lib/pdf";

/**
 * Buyer invoices. One per confirmed job, built from the job's stored quote
 * breakdown and its buyer-ledger rows (the charge, and a refund line when the
 * deadline was missed), so the invoice always matches what was booked.
 */

export interface InvoiceEntry {
  at: Date;
  kind: "charge" | "refund";
  memo: string;
  amountPaise: number;
}

export interface InvoiceData {
  number: string;
  issuedAt: Date;
  accountEmail: string | null;
  jobId: string;
  workloadType: WorkloadType;
  gpuClass: NodeClass;
  itemCount: number;
  status: string;
  deadlineAt: Date;
  completedAt: Date | null;
  breakdown: QuoteBreakdown;
  entries: InvoiceEntry[];
  netPaidPaise: number;
}

/** NS-ABCD1234: the first 8 hex characters of the job id. */
export function invoiceNumber(jobId: string): string {
  return `NS-${jobId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export async function loadInvoice(db: Db, buyerId: string, jobId: string): Promise<InvoiceData> {
  if (!z.uuid().safeParse(jobId).success) throw notFound();
  const [row] = await db
    .select({ job: jobs, email: users.email })
    .from(jobs)
    .innerJoin(users, eq(users.id, jobs.buyerId))
    .where(and(eq(jobs.id, jobId), eq(jobs.buyerId, buyerId)))
    .limit(1);
  if (!row) throw notFound();
  const { job } = row;
  if (!job.confirmedAt) throw new CoordinatorError(409, "no_invoice", "There's no invoice until a quote is confirmed and charged.");
  const ledger = await db
    .select()
    .from(buyerLedger)
    .where(and(eq(buyerLedger.buyerId, buyerId), eq(buyerLedger.jobId, jobId)))
    .orderBy(asc(buyerLedger.createdAt), asc(buyerLedger.id));
  const entries = ledger.map((e) => ({ at: e.createdAt, kind: e.entryType, memo: e.memo ?? "", amountPaise: e.amountPaise }));
  return {
    number: invoiceNumber(job.id),
    issuedAt: job.confirmedAt,
    accountEmail: row.email,
    jobId: job.id,
    workloadType: job.workloadType,
    gpuClass: job.gpuClass,
    itemCount: job.itemCount,
    status: job.status,
    deadlineAt: job.deadlineAt,
    completedAt: job.completedAt,
    breakdown: job.breakdown as QuoteBreakdown,
    entries,
    netPaidPaise: entries.reduce((s, e) => s + e.amountPaise, 0),
  };
}

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatIst(d: Date): string {
  return `${IST.format(d)} IST`;
}

/** Invoice amounts: "Rs. 1,234.50" style, always with paise. */
function money(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = new Intl.NumberFormat("en-IN").format(Math.floor(abs / 100));
  return `${sign}Rs. ${whole}.${String(abs % 100).padStart(2, "0")}`;
}

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Finished",
  deadline_missed: "Deadline missed (refunded)",
  failed: "Couldn't finish (refunded)",
  cancelled: "Cancelled",
};

/** The invoice as positioned text, ready for renderPdf. Exported for tests. */
export function invoiceLayout(inv: InvoiceData): { texts: PdfText[]; lines: PdfLine[] } {
  const L = 56;
  const R = 539;
  const texts: PdfText[] = [];
  const lines: PdfLine[] = [];
  let y = 70;
  const row = (label: string, amount: string, opts: { bold?: boolean } = {}) => {
    texts.push({ text: label, x: L, y, font: opts.bold ? "bold" : "regular", size: 10 });
    texts.push({ text: amount, x: R, y, font: "mono", size: 10, alignRight: true });
    y += 18;
  };
  const info = (label: string, value: string) => {
    texts.push({ text: label, x: L, y, font: "bold", size: 9 });
    texts.push({ text: value, x: L + 110, y, size: 9 });
    y += 14;
  };

  texts.push({ text: "NightShift", x: L, y, font: "bold", size: 20 });
  texts.push({ text: "INVOICE", x: R, y, font: "mono", size: 14, alignRight: true });
  y += 22;
  texts.push({ text: "Demo mode: payments are simulated. No real money moved.", x: L, y, size: 9 });
  y += 30;

  info("Invoice number", inv.number);
  info("Issued", formatIst(inv.issuedAt));
  info("Billed to", inv.accountEmail ?? "Your NightShift account");
  info("Job", inv.jobId);
  info("Work", `${WORKLOADS[inv.workloadType].label}, ${inv.itemCount} items, ${CLASS_SPECS[inv.gpuClass].label}`);
  info("Pieces", String(inv.breakdown.fragments));
  info("Finish by", formatIst(inv.deadlineAt));
  info("Status", `${STATUS_TEXT[inv.status] ?? inv.status}${inv.completedAt ? `, finished ${formatIst(inv.completedAt)}` : ""}`);
  y += 16;

  texts.push({ text: "Price breakdown (from your quote)", x: L, y, font: "bold", size: 11 });
  y += 8;
  lines.push({ x1: L, y1: y, x2: R, y2: y });
  y += 16;
  const b = inv.breakdown;
  row("Owners' pay for GPU time", money(b.ownerPayPaise));
  row("Electricity, paid to owners", money(b.electricityPaise));
  row("Verification buffer (re-running about 10% of pieces)", money(b.verificationBufferPaise));
  row("NightShift fee", money(b.nightshiftFeePaise));
  lines.push({ x1: L, y1: y - 10, x2: R, y2: y - 10 });
  row("Quoted price", money(b.totalPaise), { bold: true });
  y += 12;

  texts.push({ text: "Payments", x: L, y, font: "bold", size: 11 });
  y += 8;
  lines.push({ x1: L, y1: y, x2: R, y2: y });
  y += 16;
  for (const e of inv.entries) {
    const label = e.kind === "refund" ? `Refund, ${formatIst(e.at)}: ${e.memo}` : `Charge, ${formatIst(e.at)}`;
    row(label.length > 80 ? `${label.slice(0, 77)}...` : label, money(e.amountPaise));
  }
  lines.push({ x1: L, y1: y - 10, x2: R, y2: y - 10 });
  row("Total paid", money(inv.netPaidPaise), { bold: true });
  y += 16;

  if (inv.entries.some((e) => e.kind === "refund")) {
    texts.push({ text: "We missed the finish time or couldn't finish the job, so the full price was refunded.", x: L, y, size: 9 });
    y += 14;
  }
  texts.push({ text: "Amounts in Indian rupees. GST isn't charged on this prototype.", x: L, y, size: 9 });
  y += 14;
  texts.push({ text: `Generated ${formatIst(new Date())}.`, x: L, y, size: 9 });
  return { texts, lines };
}

export function invoicePdf(inv: InvoiceData): Uint8Array {
  return renderPdf({ title: `NightShift invoice ${inv.number}`, ...invoiceLayout(inv) });
}

