import { ZodError, type z } from "zod";
import { AuthzError } from "@/lib/auth/authz-error";
import { CoordinatorError } from "@/lib/coordinator/errors";
import { WorkloadInputError } from "@/lib/coordinator/workloads";
import type { LimitResult } from "@/lib/ratelimit";
import { retryAfterSeconds } from "@/lib/ratelimit";

/**
 * Shared HTTP plumbing for the JSON API. Errors map to a small set of stable
 * codes. Nothing internal (stack traces, SQL, Zod paths into secrets) ever
 * reaches the client: unknown errors become a bare 500.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorJson(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: code, message }, status, headers);
}

export function rateLimited(result: LimitResult): Response {
  return errorJson(429, "rate_limited", "Too many requests. Try again shortly.", {
    "Retry-After": String(retryAfterSeconds(result)),
  });
}

/** Reads at most `max` bytes. Refuses early on Content-Length, and again while streaming. */
export async function readBody(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) throw new CoordinatorError(413, "too_large", "Request body is too large.");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new CoordinatorError(413, "too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function readJson<T extends z.ZodType>(req: Request, schema: T, max = 64 * 1024): Promise<z.infer<T>> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new CoordinatorError(415, "unsupported_media_type", "Send JSON.");
  const bytes = await readBody(req, max);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CoordinatorError(400, "bad_json", "That isn't valid JSON.");
  }
  return schema.parse(data);
}

/** Field names that failed validation, never the values. */
function zodFields(err: ZodError): string[] {
  return [...new Set(err.issues.map((i) => i.path.join(".") || "(body)"))].slice(0, 20);
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof AuthzError) return errorJson(err.status, err.message, err.status === 401 ? "Sign in first." : "Not allowed.");
  if (err instanceof CoordinatorError) return errorJson(err.status, err.code, err.message);
  if (err instanceof WorkloadInputError) return errorJson(400, err.code, err.message);
  if (err instanceof ZodError) return json({ error: "invalid_input", message: "Some fields aren't valid.", fields: zodFields(err) }, 400);
  console.error("[api] unhandled error", err instanceof Error ? err.name : typeof err);
  return errorJson(500, "internal", "Something went wrong.");
}

/** Wraps a handler so every thrown error becomes a safe JSON response. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
}
