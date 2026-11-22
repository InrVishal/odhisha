/**
 * A minimal one-page PDF writer for invoices: text only, the PDF base-14
 * fonts (no embedding), A4. No dependency, so nothing in a third-party PDF
 * library can be tricked by buyer-controlled text.
 *
 * Text is limited to printable ASCII. Anything else is mapped (₹ → "Rs.",
 * dashes → "-") or replaced with "?", then the PDF string delimiters are
 * escaped, so no input can break out of a text operator.
 */

export type PdfFont = "regular" | "bold" | "mono";

export interface PdfText {
  text: string;
  /** Points from the left edge (A4 is 595 × 842). */
  x: number;
  /** Points from the TOP edge, which is easier to lay out than PDF's bottom-up y. */
  y: number;
  size?: number;
  font?: PdfFont;
  /** Right-align at x (mono font only: its glyphs are all 0.6 em wide). */
  alignRight?: boolean;
}

export interface PdfLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const A4 = { width: 595, height: 842 } as const;

const FONT_REF: Record<PdfFont, string> = { regular: "F1", bold: "F2", mono: "F3" };
const MONO_EM = 0.6;

const MAP: Record<string, string> = {
  "₹": "Rs.",
  "−": "-",
  "–": "-",
  "—": "-",
  "×": "x",
  "→": "->",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  " ": " ",
};

/** Printable ASCII only, with the common typographic characters mapped. */
export function toPdfAscii(input: string): string {
  let out = "";
  for (const ch of input) {
    if (MAP[ch] !== undefined) out += MAP[ch];
    else if (ch >= " " && ch <= "~") out += ch;
    else out += "?";
  }
  return out;
}

/** A PDF literal string body: ASCII, with \ ( ) escaped. */
export function pdfString(input: string): string {
  return toPdfAscii(input).replace(/[\\()]/g, (c) => `\\${c}`);
}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error("PDF coordinates must be finite");
  return String(Math.round(n * 100) / 100);
}

export function renderPdf(opts: { title: string; texts: readonly PdfText[]; lines?: readonly PdfLine[] }): Uint8Array {
  const ops: string[] = [];
  for (const l of opts.lines ?? []) {
    ops.push(`0.5 w ${num(l.x1)} ${num(A4.height - l.y1)} m ${num(l.x2)} ${num(A4.height - l.y2)} l S`);
  }
  for (const t of opts.texts) {
    const size = t.size ?? 10;
    const font = t.font ?? "regular";
    const text = toPdfAscii(t.text);
    if (t.alignRight && font !== "mono") throw new Error("right alignment needs the mono font");
    const x = t.alignRight ? t.x - text.length * MONO_EM * size : t.x;
    ops.push(`BT /${FONT_REF[font]} ${num(size)} Tf ${num(x)} ${num(A4.height - t.y)} Td (${pdfString(text)}) Tj ET`);
  }
  const content = ops.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    `<< /Title (${pdfString(opts.title)}) /Producer (NightShift) >>`,
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
