import { describe, expect, it } from "vitest";
import { invoiceLayout, invoiceNumber, invoicePdf, type InvoiceData } from "@/lib/invoice";
import { pdfString, renderPdf, toPdfAscii } from "@/lib/pdf";

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

/** Every xref offset must point at the start of "<n> 0 obj". */
function checkXref(pdf: string): void {
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)?.[1]);
  expect(pdf.slice(start, start + 4)).toBe("xref");
  const [, count] = /xref\n0 (\d+)\n/.exec(pdf.slice(start))!;
  const entries = pdf.slice(start).split("\n").slice(3, 2 + Number(count));
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    expect(pdf.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
}

const invoice = (over: Partial<InvoiceData> = {}): InvoiceData => ({
  number: "NS-ABCDEF12",
  issuedAt: new Date("2026-11-22T17:30:00Z"),
  accountEmail: "buyer@example.in",
  jobId: "abcdef12-0000-4000-8000-000000000000",
  workloadType: "text_embeddings",
  gpuClass: "cpu",
  itemCount: 600,
  status: "completed",
  deadlineAt: new Date("2026-11-23T01:30:00Z"),
  completedAt: new Date("2026-11-22T18:00:00Z"),
  breakdown: {
    ownerPayPaise: 1250,
    electricityPaise: 33,
    ownerReceivesPaise: 1283,
    verificationBufferPaise: 154,
    nightshiftFeePaise: 363,
    totalPaise: 1800,
    gpuSeconds: 1800,
    reference: { watts: 65, tariffPaisePerKwh: 900, ownerRatePaisePerHr: 2500 },
    fragments: 3,
  },
  entries: [{ at: new Date("2026-11-22T17:30:00Z"), kind: "charge", memo: "Job charge (demo_1)", amountPaise: 1800 }],
  netPaidPaise: 1800,
  ...over,
});

describe("PDF writer", () => {
  it("writes a structurally valid one-page PDF with a correct xref table", () => {
    const pdf = text(renderPdf({ title: "Test", texts: [{ text: "Hello", x: 50, y: 50 }], lines: [{ x1: 0, y1: 0, x2: 10, y2: 10 }] }));
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf).toMatch(/\/Type \/Page /);
    expect(pdf).toMatch(/\(Hello\) Tj/);
    checkXref(pdf);
    // The stream /Length must equal the bytes between "stream\n" and "\nendstream".
    const m = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf)!;
    expect(Buffer.byteLength(m[2]!, "latin1")).toBe(Number(m[1]));
  });

  it("escapes PDF string delimiters so text can't break out of a Tj operator", () => {
    expect(pdfString("a(b)c\\d")).toBe("a\\(b\\)c\\\\d");
    const evil = ") Tj ET BT /F1 99 Tf 0 0 Td (pwned";
    const pdf = text(renderPdf({ title: evil, texts: [{ text: evil, x: 1, y: 1 }] }));
    expect(pdf).not.toContain(") Tj ET BT /F1 99 Tf 0 0 Td (pwned) Tj");
    expect(pdf).toContain("\\) Tj ET BT /F1 99 Tf 0 0 Td \\(pwned");
    checkXref(pdf);
  });

  it("keeps only printable ASCII, mapping the rupee sign and dashes", () => {
    expect(toPdfAscii("₹1,200 − ₹5 – ok — “x” 2×3 →")).toBe('Rs.1,200 - Rs.5 - ok - "x" 2x3 ->');
    expect(toPdfAscii("line\nbreak\u0000null é")).toBe("line?break?null ?");
  });

  it("right-aligns only with the fixed-width font, and rejects non-finite positions", () => {
    expect(() => renderPdf({ title: "t", texts: [{ text: "x", x: 1, y: 1, alignRight: true }] })).toThrow(/mono/);
    expect(() => renderPdf({ title: "t", texts: [{ text: "x", x: Number.NaN, y: 1 }] })).toThrow(/finite/);
    const pdf = text(renderPdf({ title: "t", texts: [{ text: "12345", x: 100, y: 10, size: 10, font: "mono", alignRight: true }] }));
    // 5 glyphs × 0.6 em × 10 pt = 30 pt to the left of x.
    expect(pdf).toContain("/F3 10 Tf 70 832 Td (12345) Tj");
  });
});

describe("invoice", () => {
  it("numbers invoices from the job id", () => {
    expect(invoiceNumber("abcdef12-3456-4000-8000-000000000000")).toBe("NS-ABCDEF12");
  });

  it("lists the full quote breakdown, the charge and the total paid", () => {
    const all = invoiceLayout(invoice()).texts.map((t) => t.text);
    for (const want of [
      "INVOICE",
      "NS-ABCDEF12",
      "buyer@example.in",
      "Owners' pay for GPU time",
      "Rs. 12.50",
      "Electricity, paid to owners",
      "Rs. 0.33",
      "Verification buffer (re-running about 10% of pieces)",
      "NightShift fee",
      "Quoted price",
      "Rs. 18.00",
      "Total paid",
    ]) {
      expect(all.join("\n")).toContain(want);
    }
    expect(all.join("\n")).toContain("Demo mode");
    expect(all.join("\n")).not.toContain("Refund");
  });

  it("shows a refund line and Rs. 0.00 paid when the deadline was missed", () => {
    const inv = invoice({
      status: "deadline_missed",
      completedAt: null,
      entries: [
        { at: new Date("2026-11-22T17:30:00Z"), kind: "charge", memo: "Job charge", amountPaise: 1800 },
        { at: new Date("2026-11-23T01:31:00Z"), kind: "refund", memo: "Deadline missed: full refund (demo_r1)", amountPaise: -1800 },
      ],
      netPaidPaise: 0,
    });
    const all = invoiceLayout(inv).texts.map((t) => t.text).join("\n");
    expect(all).toMatch(/Refund, .*Deadline missed: full refund/);
    expect(all).toContain("-Rs. 18.00");
    expect(all).toContain("Rs. 0.00");
    expect(all).toContain("full price was refunded");
    const pdf = text(invoicePdf(inv));
    expect(pdf).toContain("Deadline missed \\(refunded\\)");
    checkXref(pdf);
  });

  it("falls back when the account has no email and truncates very long memos", () => {
    const all = invoiceLayout(
      invoice({ accountEmail: null, entries: [{ at: new Date(), kind: "refund", memo: "x".repeat(300), amountPaise: -1 }], netPaidPaise: -1 }),
    ).texts.map((t) => t.text);
    expect(all).toContain("Your NightShift account");
    expect(all.some((t) => t.endsWith("...") && t.length === 80)).toBe(true);
  });
});
