import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cosine,
  imageSize,
  nextTrust,
  outputsAgree,
  pickPiecesToVerify,
  QUARANTINE_BELOW,
  shouldQuarantine,
  TRUST_AFTER_RELEASE,
  verifyCount,
  words,
} from "@/lib/coordinator/verify";

const out = (items: unknown[]) => Buffer.from(JSON.stringify({ items }));

// ─── Image header fixtures (headers only: the comparison never decodes pixels) ──
function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 with the size.
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0]);
}
function webp(kind: "VP8 " | "VP8L" | "VP8X", w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write(kind, 12, "latin1");
  if (kind === "VP8 ") {
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === "VP8L") {
    b[20] = 0x2f;
    b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}
const img = (mime: string, bytes: Buffer) => ({ mime, data: bytes.toString("base64") });

describe("which pieces get checked", () => {
  it("checks about 1 in 10, and at least one", () => {
    expect([0, 1, 2, 3, 9, 10, 14, 15, 25, 100].map(verifyCount)).toEqual([0, 1, 1, 1, 1, 1, 1, 2, 3, 10]);
    expect(verifyCount(-1)).toBe(0);
    expect(verifyCount(1.5)).toBe(0);
  });

  it("picks distinct pieces in range, sorted (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300 }), (n) => {
        const seqs = pickPiecesToVerify(n);
        expect(seqs).toHaveLength(verifyCount(n));
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(seqs.every((s) => s >= 0 && s < n)).toBe(true);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      }),
    );
  });

  it("can pick every piece (no piece is never checked)", () => {
    const seen = new Set<number>();
    for (let r = 0; r < 10; r++) for (const s of pickPiecesToVerify(10, () => r)) seen.add(s);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("comparing embeddings", () => {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(i + 1));
  const unit = (a: number[]) => {
    const n = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    return a.map((x) => x / n);
  };

  it("accepts float noise between honest runs (GPU vs CPU)", () => {
    const a = unit(v);
    const b = a.map((x, i) => x + (i % 2 ? 1e-5 : -1e-5));
    expect(outputsAgree("text_embeddings", out([a, a]), out([b, a]))).toBe(true);
  });

  it("refuses made-up vectors, a shuffled order, a scaled copy and a wrong count", () => {
    const a = unit(v);
    const random = unit(Array.from({ length: 384 }, (_, i) => Math.cos(i * 7.3)));
    const other = unit(Array.from({ length: 384 }, (_, i) => Math.sin(i * 3.1 + 2)));
    expect(outputsAgree("text_embeddings", out([a]), out([random]))).toBe(false);
    expect(outputsAgree("text_embeddings", out([a, other]), out([other, a]))).toBe(false);
    expect(outputsAgree("text_embeddings", out([a]), out([a.map((x) => x * 2)]))).toBe(false);
    expect(outputsAgree("text_embeddings", out([a]), out([a, a]))).toBe(false);
    expect(outputsAgree("text_embeddings", out([a]), out([["x"]]))).toBe(false);
    expect(outputsAgree("text_embeddings", out([a]), Buffer.from("not json"))).toBe(false);
    expect(outputsAgree("text_embeddings", out([a]), Buffer.from('{"nope":1}'))).toBe(false);
  });

  it("handles zero vectors and mismatched lengths", () => {
    expect(cosine([0, 0], [0, 0])).toBe(1);
    expect(cosine([0, 0], [1, 0])).toBe(-1);
    expect(cosine([1], [1, 2])).toBe(-1);
    expect(cosine([], [])).toBe(-1);
  });
});

describe("comparing captions", () => {
  it("accepts the same caption with small differences", () => {
    expect(outputsAgree("image_captioning", out(["a red car on a road"]), out(["A red car on the road."]))).toBe(true);
    expect(outputsAgree("image_captioning", out([""]), out(["  "]))).toBe(true);
  });
  it("refuses a different caption", () => {
    expect(outputsAgree("image_captioning", out(["a red car on a road"]), out(["two dogs playing in snow"]))).toBe(false);
    expect(outputsAgree("image_captioning", out(["a cat"]), out([42]))).toBe(false);
  });
  it("splits words on punctuation and case", () => {
    expect([...words("A dog, a DOG!")]).toEqual(["a", "dog"]);
  });
});

describe("comparing resized images", () => {
  it("reads the size from PNG, JPEG and all three WebP headers", () => {
    expect(imageSize(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(1024, 768), "image/jpeg")).toEqual({ width: 1024, height: 768 });
    expect(imageSize(webp("VP8 ", 300, 200), "image/webp")).toEqual({ width: 300, height: 200 });
    expect(imageSize(webp("VP8L", 300, 200), "image/webp")).toEqual({ width: 300, height: 200 });
    expect(imageSize(webp("VP8X", 4000, 3000), "image/webp")).toEqual({ width: 4000, height: 3000 });
    expect(imageSize(Buffer.alloc(10), "image/png")).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg")).toBeNull();
    expect(imageSize(Buffer.alloc(40), "image/webp")).toBeNull();
  });

  it("accepts the same size and type with a different encode", () => {
    expect(outputsAgree("image_resize", out([img("image/png", png(512, 512))]), out([img("image/png", png(512, 512, 20))]))).toBe(true);
  });

  it("refuses a different size, type or a very different file size", () => {
    expect(outputsAgree("image_resize", out([img("image/png", png(512, 512))]), out([img("image/png", png(512, 256))]))).toBe(false);
    expect(outputsAgree("image_resize", out([img("image/png", png(8, 8))]), out([img("image/jpeg", jpeg(8, 8))]))).toBe(false);
    expect(outputsAgree("image_resize", out([img("image/png", png(8, 8))]), out([img("image/png", png(8, 8, 500))]))).toBe(false);
    expect(outputsAgree("image_resize", out([img("image/png", png(8, 8))]), out([{ mime: "image/png", data: "" }]))).toBe(false);
    expect(outputsAgree("image_resize", out([img("image/png", png(8, 8))]), out([null]))).toBe(false);
  });
});

describe("trust", () => {
  it("rises slowly, falls fast, and stays within 0..1000", () => {
    expect(nextTrust(500, "pass")).toBe(520);
    expect(nextTrust(500, "fail")).toBe(250);
    expect(nextTrust(250, "fail")).toBe(0);
    expect(nextTrust(500, "inconclusive")).toBe(450);
    expect(nextTrust(995, "pass")).toBe(1000);
    expect(nextTrust(10, "inconclusive")).toBe(0);
  });

  it("quarantines below the work line, and a release lands just above it", () => {
    expect(shouldQuarantine(QUARANTINE_BELOW - 1)).toBe(true);
    expect(shouldQuarantine(QUARANTINE_BELOW)).toBe(false);
    expect(shouldQuarantine(TRUST_AFTER_RELEASE)).toBe(false);
    // One more failed check after a release quarantines the PC again.
    expect(shouldQuarantine(nextTrust(TRUST_AFTER_RELEASE, "fail"))).toBe(true);
    // A new PC (500) survives one failed check, not two.
    expect(shouldQuarantine(nextTrust(500, "fail"))).toBe(false);
    expect(shouldQuarantine(nextTrust(nextTrust(500, "fail"), "fail"))).toBe(true);
  });
});
