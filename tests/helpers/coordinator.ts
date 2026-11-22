import { createHash, randomBytes } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import type { Deps, UserDeps } from "@/lib/api/handlers";
import * as H from "@/lib/api/handlers";
import type { SessionUser } from "@/lib/auth/authz-error";
import type { Db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { LimitResult, PolicyName } from "@/lib/ratelimit";
import type { CoordinatorKeys } from "@/lib/security/keys";
import type { SignedTask } from "@/lib/security/signing";

export const ORIGIN = "https://nightshift.test";

/** 2026-11-22 at hh:mm in India (hh may exceed 23 for the next day). */
export const ist = (hh: number, mm = 0, ss = 0) => new Date(Date.UTC(2026, 10, 22, hh, mm, ss) - 330 * 60_000);

export function testKeys(): CoordinatorKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { signingKey: privateKey, publicKey, dataKey: randomBytes(32), ephemeral: true };
}

export class Clock {
  constructor(public t: Date) {}
  now = () => new Date(this.t);
  set(d: Date) {
    this.t = d;
  }
  advance(sec: number) {
    this.t = new Date(this.t.getTime() + sec * 1000);
  }
}

/** Rate limiter that allows everything unless a policy is switched to "deny". */
export class TestLimiter {
  deny = new Set<PolicyName>();
  calls: Array<[PolicyName, string]> = [];
  limit = async (policy: PolicyName, key: string): Promise<LimitResult> => {
    this.calls.push([policy, key]);
    const denied = this.deny.has(policy);
    return { success: !denied, limit: 10, remaining: denied ? 0 : 9, reset: Date.now() + 42_000 };
  };
}

export interface Harness {
  db: Db;
  clock: Clock;
  keys: CoordinatorKeys;
  limiter: TestLimiter;
  deps: Deps;
  as: (user: SessionUser | null) => UserDeps;
}

export function harness(db: Db, start = ist(23, 0)): Harness {
  const clock = new Clock(start);
  const keys = testKeys();
  const limiter = new TestLimiter();
  const deps: Deps = {
    db,
    now: clock.now,
    keys,
    ipSecret: "test-ip-secret",
    cronSecret: "c".repeat(40),
    limit: limiter.limit,
  };
  return { db, clock, keys, limiter, deps, as: (user) => ({ ...deps, user }) };
}

export async function makeUser(db: Db, email: string): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ email }).returning();
  return { id: u!.id, role: "user" };
}

// ─── Request builders ──────────────────────────────────────────────────────

export function jsonReq(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      origin: ORIGIN,
      host: new URL(ORIGIN).host,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function agentReq(token: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: body === undefined ? "{}" : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ─── Common flows ──────────────────────────────────────────────────────────

export async function registerNode(
  h: Harness,
  owner: SessionUser,
  over: { name?: string; gpuClass?: string; patch?: Record<string, unknown> } = {},
): Promise<{ nodeId: string; token: string }> {
  const res = await H.registerNodeHandler(jsonReq("POST", "/api/nodes", { name: over.name ?? "Gaming PC", gpuClass: over.gpuClass ?? "rtx4070" }), h.as(owner));
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const b = await body<{ node: { id: string }; token: string }>(res);
  if (over.patch) {
    const p = await H.updateNodeHandler(jsonReq("PATCH", `/api/nodes/${b.node.id}`, over.patch), h.as(owner), b.node.id);
    if (p.status !== 200) throw new Error(`patch failed: ${p.status} ${await p.text()}`);
  }
  return { nodeId: b.node.id, token: b.token };
}

export async function beat(h: Harness, token: string, extra: Record<string, unknown> = {}) {
  return H.heartbeatHandler(agentReq(token, "/api/agent/heartbeat", extra), h.deps);
}

export async function quoteTexts(h: Harness, buyer: SessionUser, n: number, gpuClass = "rtx4070") {
  const texts = Array.from({ length: n }, (_, i) => `sentence number ${i}`);
  return H.quoteHandler(jsonReq("POST", "/api/jobs/quote", { workloadType: "text_embeddings", gpuClass, params: {}, texts }), h.as(buyer));
}

export interface Leased {
  task: SignedTask;
  input: string;
  leaseExpiresAt: string;
  parsed: { taskId: string; attempt: number; itemCount: number; inputSha256: string; nodeId: string; jobId: string };
}

export async function lease(h: Harness, token: string): Promise<Leased | null> {
  const res = await H.leaseHandler(agentReq(token, "/api/agent/lease"), h.deps);
  if (res.status !== 200) throw new Error(`lease failed: ${res.status} ${await res.text()}`);
  const b = await body<Leased & { task: SignedTask | null }>(res);
  if (!b.task) return null;
  return { ...b, parsed: JSON.parse(b.task.task) };
}

/** A valid embeddings output for the leased piece: item i gets [i, i, ...]. */
export function embeddingsFor(l: Leased): Buffer {
  const input = JSON.parse(Buffer.from(l.input, "base64").toString()) as { texts: string[] };
  const items = input.texts.map((t) => Array(384).fill(Number(t.split(" ").pop())));
  return Buffer.from(JSON.stringify({ items }));
}

export async function complete(h: Harness, token: string, l: Leased, out = embeddingsFor(l), sha?: string) {
  return H.completeHandler(
    new Request(`${ORIGIN}/api/agent/fragments/${l.parsed.taskId}/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-lease-attempt": String(l.parsed.attempt),
        "x-output-sha256": sha ?? createHash("sha256").update(out).digest("hex"),
      },
      body: new Uint8Array(out),
    }),
    h.deps,
    l.parsed.taskId,
  );
}
