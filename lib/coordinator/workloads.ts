import { z } from "zod";
import { ALLOWED_IMAGE_TYPES, sniffImageType, type AllowedImageType } from "@/lib/security/filetype";
import { BASELINE_BENCHMARK_SCORE } from "@/lib/timebank";

/**
 * The workload whitelist. Agents only ever run these, each from a pinned
 * container image. Buyers send DATA and PARAMETERS (validated below), never
 * code, scripts, model names outside the enum, or URLs to fetch.
 *
 * Every workload takes a list of items (texts or images) and returns one
 * result per item, in order:
 *   fragment input  = JSON {"texts": [...]}  or  {"images": [{"name","mime","data"}]}
 *   fragment output = JSON {"items": [...]}  (one entry per input item)
 * Image bytes are base64 in both directions.
 */

export const WORKLOAD_TYPES = ["text_embeddings", "image_captioning", "image_resize"] as const;
export type WorkloadType = (typeof WORKLOAD_TYPES)[number];

export type InputItem =
  | { kind: "text"; text: string }
  | { kind: "image"; name: string; mime: AllowedImageType; data: Buffer };

export interface WorkloadLimits {
  maxItems: number;
  /** Per text (UTF-8 bytes) or per image. */
  maxItemBytes: number;
  maxTotalBytes: number;
  maxItemsPerFragment: number;
  maxFragmentBytes: number;
}

export interface CostModel {
  /** Container start and model load, per fragment, in seconds. */
  overheadSec: number;
  /** Per item on the baseline GPU (RTX 3060, benchmark 1000), in ms. */
  perItemMsAtBaseline: number;
}

export interface WorkloadSpec<P = unknown> {
  type: WorkloadType;
  label: string;
  itemKind: "text" | "image";
  /** Container image. Digest-pinned (`name@sha256:...`) from phase 4 on. */
  image: string | null;
  params: z.ZodType<P>;
  limits: WorkloadLimits;
  cost: CostModel;
  /** Validates an agent's output for a fragment of `itemCount` items. */
  output: (itemCount: number, params: P) => z.ZodType<{ items: unknown[] }>;
}

/** The request body (and so a fragment's input or output) can't exceed this on Vercel. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Agents upload one fragment's output per request. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const EMBEDDING_MODELS = { "all-MiniLM-L6-v2": 384 } as const;
const CAPTION_MODELS = ["blip-base"] as const;
const FORMAT_MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const satisfies Record<
  string,
  AllowedImageType
>;

const embeddingParams = z.strictObject({
  model: z.enum(Object.keys(EMBEDDING_MODELS) as [keyof typeof EMBEDDING_MODELS]).default("all-MiniLM-L6-v2"),
  normalize: z.boolean().default(true),
});
export type EmbeddingParams = z.infer<typeof embeddingParams>;

const captionParams = z.strictObject({
  model: z.enum(CAPTION_MODELS).default("blip-base"),
  maxWords: z.int().min(5).max(40).default(20),
});
export type CaptionParams = z.infer<typeof captionParams>;

const resizeParams = z.strictObject({
  width: z.int().min(1).max(4096),
  height: z.int().min(1).max(4096),
  fit: z.enum(["cover", "contain", "inside"]).default("inside"),
  format: z.enum(["png", "jpeg", "webp"]).default("webp"),
  quality: z.int().min(1).max(100).default(85),
});
export type ResizeParams = z.infer<typeof resizeParams>;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64");

/** An image in an agent's output must really be the requested format. */
function imageOutput(mime: AllowedImageType, maxBytes: number) {
  return z.strictObject({ mime: z.literal(mime), data: base64 }).superRefine((v, ctx) => {
    const bytes = Buffer.from(v.data, "base64");
    if (bytes.length === 0 || bytes.length > maxBytes) ctx.addIssue({ code: "custom", message: "image size out of range" });
    else if (sniffImageType(bytes) !== mime) ctx.addIssue({ code: "custom", message: "image bytes don't match its type" });
  });
}

export const WORKLOADS: { readonly [K in WorkloadType]: WorkloadSpec } = {
  text_embeddings: {
    type: "text_embeddings",
    label: "Batch text embeddings",
    itemKind: "text",
    image: "ghcr.io/inrvishal/nightshift-text-embeddings@sha256:a9ff2b9891d3cec528dab64da92909130634f1f699578b6c14aca495fab909c4",
    params: embeddingParams,
    limits: {
      maxItems: 5000,
      maxItemBytes: 8 * 1024,
      maxTotalBytes: 3 * 1024 * 1024,
      maxItemsPerFragment: 250,
      maxFragmentBytes: 512 * 1024,
    },
    cost: { overheadSec: 30, perItemMsAtBaseline: 4 },
    output: (n, p) => {
      const dims = EMBEDDING_MODELS[(p as EmbeddingParams).model];
      return z.strictObject({ items: z.array(z.array(z.number().finite()).length(dims)).length(n) });
    },
  },
  image_captioning: {
    type: "image_captioning",
    label: "Batch image captioning",
    itemKind: "image",
    image: "ghcr.io/inrvishal/nightshift-image-captioning@sha256:410b6897685f4cc161bc0720b2ab78e4869f8cc7677345293f68ff6964e93413",
    params: captionParams,
    limits: {
      maxItems: 200,
      maxItemBytes: 1024 * 1024,
      maxTotalBytes: 3 * 1024 * 1024,
      maxItemsPerFragment: 20,
      maxFragmentBytes: 1024 * 1024,
    },
    cost: { overheadSec: 45, perItemMsAtBaseline: 400 },
    output: (n, p) => {
      const maxWords = (p as CaptionParams).maxWords;
      const caption = z
        .string()
        .max(maxWords * 20)
        .refine((s) => s.trim().split(/\s+/).length <= maxWords, "caption too long");
      return z.strictObject({ items: z.array(caption).length(n) });
    },
  },
  image_resize: {
    type: "image_resize",
    label: "Batch image resizing",
    itemKind: "image",
    image: "ghcr.io/inrvishal/nightshift-image-resize@sha256:61e6fe0a2d988da99c0cf0e109112f9227042bb334b1a06c7116ea68a33253ea",
    params: resizeParams,
    limits: {
      maxItems: 200,
      maxItemBytes: 1024 * 1024,
      maxTotalBytes: 3 * 1024 * 1024,
      maxItemsPerFragment: 20,
      maxFragmentBytes: 1024 * 1024,
    },
    cost: { overheadSec: 10, perItemMsAtBaseline: 60 },
    output: (n, p) => {
      const mime = FORMAT_MIME[(p as ResizeParams).format];
      // Base64 grows data by 4/3, so this keeps the whole output under the cap.
      const perImage = Math.floor((MAX_OUTPUT_BYTES * 3) / 4 / Math.max(n, 1));
      return z.strictObject({ items: z.array(imageOutput(mime, perImage)).length(n) });
    },
  },
};

export class WorkloadInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkloadInputError";
  }
}

function itemBytes(item: InputItem): number {
  return item.kind === "text" ? Buffer.byteLength(item.text, "utf8") : item.data.length;
}

/** Checks the item list against the workload's limits. Throws WorkloadInputError. */
export function checkItems(spec: WorkloadSpec, items: readonly InputItem[]): void {
  const { limits } = spec;
  if (items.length === 0) throw new WorkloadInputError("no_items", "Add at least one item.");
  if (items.length > limits.maxItems) {
    throw new WorkloadInputError("too_many_items", `At most ${limits.maxItems} items per job.`);
  }
  let total = 0;
  for (const [i, item] of items.entries()) {
    if (item.kind !== spec.itemKind) throw new WorkloadInputError("wrong_item_kind", `Item ${i + 1} is the wrong kind.`);
    const bytes = itemBytes(item);
    if (bytes === 0) throw new WorkloadInputError("empty_item", `Item ${i + 1} is empty.`);
    if (bytes > limits.maxItemBytes) throw new WorkloadInputError("item_too_large", `Item ${i + 1} is too large.`);
    if (item.kind === "image" && sniffImageType(item.data) !== item.mime) {
      throw new WorkloadInputError("bad_file_type", `Item ${i + 1} isn't a PNG, JPEG or WebP image.`);
    }
    total += bytes;
  }
  if (total > limits.maxTotalBytes) throw new WorkloadInputError("job_too_large", "The job's data is too large.");
}

/**
 * Splits items into fragments, in order, so each fragment stays under both
 * the item and byte limits. Returns index ranges [start, end).
 */
export function splitItems(spec: WorkloadSpec, items: readonly InputItem[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < items.length; i++) {
    const b = itemBytes(items[i]!);
    const count = i - start;
    if (count > 0 && (count >= spec.limits.maxItemsPerFragment || bytes + b > spec.limits.maxFragmentBytes)) {
      out.push([start, i]);
      start = i;
      bytes = 0;
    }
    bytes += b;
  }
  out.push([start, items.length]);
  return out;
}

/** Serialises a fragment's items to the bytes the agent receives. */
export function encodeFragmentInput(items: readonly InputItem[]): Buffer {
  const texts = items.filter((i) => i.kind === "text");
  if (texts.length === items.length) return Buffer.from(JSON.stringify({ texts: texts.map((t) => t.text) }), "utf8");
  return Buffer.from(
    JSON.stringify({
      images: items.map((i) => {
        if (i.kind !== "image") throw new WorkloadInputError("wrong_item_kind", "mixed item kinds");
        return { name: i.name, mime: i.mime, data: i.data.toString("base64") };
      }),
    }),
    "utf8",
  );
}

/**
 * Estimated seconds for one fragment on a machine with this benchmark score.
 * Overhead is fixed; per-item time scales with the benchmark (RTX 3060 = 1000).
 */
export function estimateSeconds(spec: WorkloadSpec, itemCount: number, benchmark: number): number {
  const b = Math.max(1, benchmark);
  return spec.cost.overheadSec + Math.ceil((itemCount * spec.cost.perItemMsAtBaseline * BASELINE_BENCHMARK_SCORE) / b / 1000);
}

/** Parses and validates an agent's output. Returns the parsed items or null. */
export function parseOutput(spec: WorkloadSpec, itemCount: number, params: unknown, bytes: Uint8Array): unknown[] | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
  const parsed = spec.output(itemCount, params).safeParse(json);
  return parsed.success ? parsed.data.items : null;
}

export function isWorkloadType(v: string): v is WorkloadType {
  return (WORKLOAD_TYPES as readonly string[]).includes(v);
}

export { ALLOWED_IMAGE_TYPES };
