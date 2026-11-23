import { randomInt } from "node:crypto";
import type { AllowedImageType } from "@/lib/security/filetype";
import { MIN_TRUST_FOR_WORK } from "./schedule";
import type { WorkloadType } from "./workloads";

/**
 * Verification maths. Pure, no I/O (the database side is in verification.ts).
 *
 * About 1 piece in 10 of every job, and at least one, is re-run on a second
 * PC once it's done. The two outputs are compared within a tolerance that
 * allows for honest differences (float rounding between GPUs and CPUs) but not
 * for made-up results. A disagreement is settled by a third PC.
 */

/** Share of each job's pieces that get re-run. */
export const VERIFY_RATE = 0.1;

/** How many of a job's pieces to check: 10%, rounded, never fewer than one. */
export function verifyCount(pieces: number): number {
  if (!Number.isSafeInteger(pieces) || pieces < 1) return 0;
  return Math.min(pieces, Math.max(1, Math.round(pieces * VERIFY_RATE)));
}

/** Picks which pieces (by seq) to check, uniformly at random without repeats. */
export function pickPiecesToVerify(pieces: number, rand: (max: number) => number = randomInt): number[] {
  const seqs = Array.from({ length: Math.max(0, pieces) }, (_, i) => i);
  // Partial Fisher-Yates: the first k positions are a uniform random sample.
  const k = verifyCount(pieces);
  for (let i = 0; i < k; i++) {
    const j = i + rand(seqs.length - i);
    [seqs[i], seqs[j]] = [seqs[j]!, seqs[i]!];
  }
  return seqs.slice(0, k).sort((a, b) => a - b);
}

// ─── How often a PC is checked ─────────────────────────────────────────────

/** A new PC's first this-many pieces are checked at NEW_PC_RATE. */
export const NEW_PC_PIECES = 20;
export const NEW_PC_RATE = 0.5;
/** Trust a PC starts with; at or below it, it's checked at NEW_PC_RATE. */
export const START_TRUST = 500;
/** At this trust and above, the rate is down to the floor (VERIFY_RATE). */
export const TRUSTED_AT = 900;

/**
 * Share of a PC's pieces that get re-run: 50% for its first 20, then falling
 * with trust (500 → 50%, 700 → 30%, 900 → 10%), never below 10%. A PC whose
 * trust drops back to 500 or less is at 50% again.
 */
export function checkRate(node: { piecesDone: number; trustScore: number }): number {
  if (node.piecesDone < NEW_PC_PIECES || node.trustScore <= START_TRUST) return NEW_PC_RATE;
  const t = Math.min(1, (node.trustScore - START_TRUST) / (TRUSTED_AT - START_TRUST));
  return Math.max(VERIFY_RATE, NEW_PC_RATE - t * (NEW_PC_RATE - VERIFY_RATE));
}

/**
 * Chance that a piece NOT picked at confirm time is checked anyway, so that
 * the PC's overall rate is checkRate(): picked (≈10%) or extra.
 */
export function extraCheckChance(rate: number): number {
  return Math.max(0, Math.min(1, (rate - VERIFY_RATE) / (1 - VERIFY_RATE)));
}

// ─── Comparing outputs ─────────────────────────────────────────────────────

/** Cosine similarity two honest runs of the same embedding model always beat. */
export const MIN_EMBEDDING_COSINE = 0.995;
/** Word overlap (Jaccard) two honest captions of the same image always beat. */
export const MIN_CAPTION_OVERLAP = 0.5;
/** Two honest encodes of the same resize differ in size by less than this factor. */
export const MAX_IMAGE_SIZE_RATIO = 2;

function items(bytes: Uint8Array): unknown[] | null {
  try {
    const v = JSON.parse(Buffer.from(bytes).toString("utf8")) as { items?: unknown };
    return Array.isArray(v.items) ? v.items : null;
  } catch {
    return null;
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return na === nb ? 1 : -1;
  return dot / Math.sqrt(na * nb);
}

function sameEmbedding(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (!a.every((x) => typeof x === "number") || !b.every((x) => typeof x === "number")) return false;
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const [na, nb] = [norm(a as number[]), norm(b as number[])];
  // Same length too, so a scaled copy of the right direction doesn't pass.
  if (Math.abs(na - nb) > 0.01 * Math.max(na, nb, 1e-9)) return false;
  return cosine(a as number[], b as number[]) >= MIN_EMBEDDING_COSINE;
}

export function words(caption: string): Set<string> {
  return new Set(
    caption
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function sameCaption(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [wa, wb] = [words(a), words(b)];
  if (wa.size === 0 && wb.size === 0) return true;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both += 1;
  return both / (wa.size + wb.size - both) >= MIN_CAPTION_OVERLAP;
}

/** Width and height from the image header, or null if it can't be read. */
export function imageSize(bytes: Buffer, mime: AllowedImageType): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (bytes.length < 24) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      const len = bytes.readUInt16BE(i + 2);
      // SOF0..SOF15 hold the size, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP then a VP8 / VP8L / VP8X chunk.
  if (bytes.length < 30) return null;
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return null;
}

function sameImage(a: unknown, b: unknown): boolean {
  const ia = a as { mime?: AllowedImageType; data?: string } | null;
  const ib = b as { mime?: AllowedImageType; data?: string } | null;
  if (!ia?.mime || !ib?.mime || ia.mime !== ib.mime || typeof ia.data !== "string" || typeof ib.data !== "string") return false;
  const [ba, bb] = [Buffer.from(ia.data, "base64"), Buffer.from(ib.data, "base64")];
  if (ba.length === 0 || bb.length === 0) return false;
  if (Math.max(ba.length, bb.length) / Math.min(ba.length, bb.length) > MAX_IMAGE_SIZE_RATIO) return false;
  const [sa, sb] = [imageSize(ba, ia.mime), imageSize(bb, ib.mime)];
  return sa !== null && sb !== null && sa.width === sb.width && sa.height === sb.height;
}

/**
 * True when two outputs for the same piece agree. Both have already passed
 * the workload's output schema (lib/coordinator/workloads.ts).
 */
export function outputsAgree(workload: WorkloadType, a: Uint8Array, b: Uint8Array): boolean {
  const [ia, ib] = [items(a), items(b)];
  if (!ia || !ib || ia.length !== ib.length) return false;
  const same = workload === "text_embeddings" ? sameEmbedding : workload === "image_captioning" ? sameCaption : sameImage;
  return ia.every((x, i) => same(x, ib[i]));
}

// ─── Trust ─────────────────────────────────────────────────────────────────

export const TRUST_MAX = 1000;
/** A passed check. Slow to earn... */
export const TRUST_PASS = 20;
/** ...and fast to lose: two failed checks take a new PC (500) to 0. */
export const TRUST_FAIL = 250;
/** When three PCs all disagree, nobody can be blamed, so everyone loses a little. */
export const TRUST_INCONCLUSIVE = 50;
/** Below this a PC is quarantined: it gets no work until an admin releases it. */
export const QUARANTINE_BELOW = MIN_TRUST_FOR_WORK;
/** Where an admin release puts a PC: just above the line, so one more failure quarantines it again. */
export const TRUST_AFTER_RELEASE = QUARANTINE_BELOW + 100;

/** Taking a piece and letting its lease run out (hoarding, or just going away). */
export const TRUST_LEASE_EXPIRED = 25;

export type CheckResult = "pass" | "fail" | "inconclusive";

export function nextTrust(score: number, result: CheckResult): number {
  const delta = result === "pass" ? TRUST_PASS : result === "fail" ? -TRUST_FAIL : -TRUST_INCONCLUSIVE;
  return Math.min(TRUST_MAX, Math.max(0, score + delta));
}

export function shouldQuarantine(score: number): boolean {
  return score < QUARANTINE_BELOW;
}
