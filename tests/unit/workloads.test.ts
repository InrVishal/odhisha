import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkItems,
  encodeFragmentInput,
  parseOutput,
  splitItems,
  WorkloadInputError,
  WORKLOAD_TYPES,
  WORKLOADS,
  type InputItem,
} from "@/lib/coordinator/workloads";
import { sniffImageType } from "@/lib/security/filetype";
import { PNG_1PX } from "../helpers/fixtures";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

const texts = (n: number, s = "hello world"): InputItem[] => Array.from({ length: n }, () => ({ kind: "text", text: s }));

describe("file types by magic bytes", () => {
  it("accepts PNG, JPEG and WebP by their bytes", () => {
    expect(sniffImageType(PNG_1PX)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it.each([
    ["SVG (can carry script)", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["GIF", Buffer.from("GIF89a....")],
    ["HTML", Buffer.from("<!doctype html><script>x</script>")],
    ["PDF", Buffer.from("%PDF-1.7")],
    ["ELF executable", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ["Windows executable", Buffer.from("MZ\x90\x00")],
    ["zip", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ["RIFF that isn't WebP (WAV)", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])],
    ["empty", Buffer.alloc(0)],
  ])("refuses %s", (_name, bytes) => {
    expect(sniffImageType(bytes)).toBeNull();
  });
});

describe("workload whitelist", () => {
  it("has exactly the three whitelisted workloads", () => {
    expect([...WORKLOAD_TYPES].sort()).toEqual(["image_captioning", "image_resize", "text_embeddings"]);
    for (const t of WORKLOAD_TYPES) expect(WORKLOADS[t].type).toBe(t);
  });

  it("accepts parameters, never code or unknown keys", () => {
    const p = WORKLOADS.text_embeddings.params;
    expect(p.parse({})).toEqual({ model: "all-MiniLM-L6-v2", normalize: true });
    expect(p.safeParse({ model: "evil/model" }).success).toBe(false);
    expect(p.safeParse({ script: "import os; os.system('x')" }).success).toBe(false);
    expect(p.safeParse({ model: "all-MiniLM-L6-v2", command: ["sh"] }).success).toBe(false);
    expect(WORKLOADS.image_resize.params.safeParse({ width: 0, height: 10 }).success).toBe(false);
    expect(WORKLOADS.image_resize.params.safeParse({ width: 100, height: 100, format: "svg" }).success).toBe(false);
    expect(WORKLOADS.image_resize.params.safeParse({ width: 100, height: 100, url: "http://169.254.169.254/" }).success).toBe(false);
  });

  it("enforces item and size limits", () => {
    const spec = WORKLOADS.text_embeddings;
    expect(() => checkItems(spec, [])).toThrow(WorkloadInputError);
    expect(() => checkItems(spec, texts(spec.limits.maxItems + 1))).toThrow(/At most/);
    expect(() => checkItems(spec, [{ kind: "text", text: "x".repeat(spec.limits.maxItemBytes + 1) }])).toThrow(/too large/);
    expect(() => checkItems(spec, [{ kind: "text", text: "" }])).toThrow(/empty/);
    expect(() => checkItems(spec, texts(500, "x".repeat(8000)))).toThrow(/too large/);
    expect(() => checkItems(spec, texts(10))).not.toThrow();
  });

  it("checks image bytes, not the declared type", () => {
    const spec = WORKLOADS.image_resize;
    const svg = Buffer.from("<svg></svg>");
    expect(() => checkItems(spec, [{ kind: "image", name: "a.png", mime: "image/png", data: svg }])).toThrow(/PNG, JPEG or WebP/);
    expect(() => checkItems(spec, [{ kind: "image", name: "a.png", mime: "image/jpeg", data: PNG_1PX }])).toThrow();
    expect(() => checkItems(spec, [{ kind: "image", name: "a.png", mime: "image/png", data: PNG_1PX }])).not.toThrow();
    expect(() => checkItems(spec, texts(1))).toThrow(/wrong kind/);
  });

  it("splits into pieces that respect both limits and keep every item in order", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 8000 }), { minLength: 1, maxLength: 2000 }), (sizes) => {
        const spec = WORKLOADS.text_embeddings;
        const items: InputItem[] = sizes.map((n) => ({ kind: "text", text: "a".repeat(n) }));
        const ranges = splitItems(spec, items);
        let next = 0;
        for (const [a, b] of ranges) {
          if (a !== next || b <= a) return false;
          if (b - a > spec.limits.maxItemsPerFragment) return false;
          const bytes = sizes.slice(a, b).reduce((x, y) => x + y, 0);
          if (b - a > 1 && bytes > spec.limits.maxFragmentBytes) return false;
          next = b;
        }
        return next === items.length;
      }),
    );
  });

  it("encodes fragment input as JSON the agent can read", () => {
    expect(JSON.parse(encodeFragmentInput(texts(2, "hi")).toString())).toEqual({ texts: ["hi", "hi"] });
    const img = JSON.parse(encodeFragmentInput([{ kind: "image", name: "a.png", mime: "image/png", data: PNG_1PX }]).toString());
    expect(Buffer.from(img.images[0].data, "base64").equals(PNG_1PX)).toBe(true);
  });
});

describe("agent output validation", () => {
  it("accepts well-formed embeddings and rejects anything else", () => {
    const spec = WORKLOADS.text_embeddings;
    const params = spec.params.parse({});
    const good = Buffer.from(JSON.stringify({ items: [Array(384).fill(0.1), Array(384).fill(-0.2)] }));
    expect(parseOutput(spec, 2, params, good)).toHaveLength(2);
    expect(parseOutput(spec, 3, params, good)).toBeNull(); // wrong count
    expect(parseOutput(spec, 1, params, Buffer.from(JSON.stringify({ items: [Array(10).fill(0)] })))).toBeNull(); // wrong dims
    expect(parseOutput(spec, 1, params, Buffer.from('{"items":[[1,2,"x"]]}'))).toBeNull();
    expect(parseOutput(spec, 1, params, Buffer.from("not json"))).toBeNull();
    expect(parseOutput(spec, 1, params, Buffer.from(JSON.stringify({ items: [Array(384).fill(0)], extra: 1 })))).toBeNull();
  });

  it("only accepts resized images that really are the requested format", () => {
    const spec = WORKLOADS.image_resize;
    const params = spec.params.parse({ width: 10, height: 10, format: "png" });
    const out = (data: Buffer, mime = "image/png") => Buffer.from(JSON.stringify({ items: [{ mime, data: data.toString("base64") }] }));
    expect(parseOutput(spec, 1, params, out(PNG_1PX))).toHaveLength(1);
    expect(parseOutput(spec, 1, params, out(Buffer.from("<svg/>")))).toBeNull();
    expect(parseOutput(spec, 1, params, out(JPEG, "image/jpeg"))).toBeNull();
  });

  it("caps caption length", () => {
    const spec = WORKLOADS.image_captioning;
    const params = spec.params.parse({ maxWords: 5 });
    expect(parseOutput(spec, 1, params, Buffer.from(JSON.stringify({ items: ["a dog on a beach"] })))).toHaveLength(1);
    expect(parseOutput(spec, 1, params, Buffer.from(JSON.stringify({ items: ["one two three four five six"] })))).toBeNull();
  });
});
