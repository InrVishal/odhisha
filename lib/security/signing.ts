import { createHash, randomBytes, sign, verify, type KeyObject } from "node:crypto";

/**
 * Signed tasks (coordinator → agent).
 *
 * The coordinator serialises the task to JSON ONCE and signs those exact
 * bytes with Ed25519. The agent receives the same string and the signature,
 * verifies the signature over the bytes it received, and only then parses
 * them. No canonical-JSON step, so Python and TypeScript can't disagree about
 * key order or number formatting.
 *
 * The agent (phase 4) must also check, before running anything:
 * - `exp` is in the future (tasks are short-lived: the lease length),
 * - `nonce` hasn't been seen before (it keeps every nonce until `exp`),
 * - `nodeId` is its own id,
 * - sha256(input bytes) equals `inputSha256`,
 * - `workload` and `image` are on its own built-in whitelist.
 */

export const TASK_VERSION = 1;

export interface Task {
  v: typeof TASK_VERSION;
  /** The fragment id. */
  taskId: string;
  jobId: string;
  nodeId: string;
  /** Lease attempt number. The agent echoes it back on complete/fail. */
  attempt: number;
  workload: string;
  /** Container image, digest-pinned (filled in by phase 4). */
  image: string | null;
  params: unknown;
  itemCount: number;
  inputSha256: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
  /** 128 random bits, base64url. */
  nonce: string;
}

export interface SignedTask {
  /** The exact JSON text that was signed. */
  task: string;
  /** Ed25519 signature over the UTF-8 bytes of `task`, base64. */
  signature: string;
  /** Key id, so agents can tell which pinned key to use after a rotation. */
  kid: string;
}

/** Short fingerprint of a public key: first 16 hex chars of sha256(SPKI DER). */
export function keyId(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);
}

export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function signTask(task: Task, privateKey: KeyObject, publicKey: KeyObject): SignedTask {
  const text = JSON.stringify(task);
  return {
    task: text,
    signature: sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64"),
    kid: keyId(publicKey),
  };
}

/**
 * Reference verifier: what the agent does, in TypeScript. Used by tests (and
 * any future TypeScript agent). Returns the task only if every check passes.
 */
export function verifySignedTask(
  signed: SignedTask,
  publicKey: KeyObject,
  opts: { nodeId: string; now?: number; seenNonces?: Set<string> },
): Task {
  const ok = verify(null, Buffer.from(signed.task, "utf8"), publicKey, Buffer.from(signed.signature, "base64"));
  if (!ok) throw new Error("bad signature");
  const task = JSON.parse(signed.task) as Task;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (task.v !== TASK_VERSION) throw new Error("unknown task version");
  if (task.exp <= now) throw new Error("expired");
  if (task.nodeId !== opts.nodeId) throw new Error("task is for another node");
  if (opts.seenNonces) {
    if (opts.seenNonces.has(task.nonce)) throw new Error("replayed nonce");
    opts.seenNonces.add(task.nonce);
  }
  return task;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Public key as PEM, published at /api/agent/signing-key for pinning. */
export function publicKeyPem(publicKey: KeyObject): string {
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}
