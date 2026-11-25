import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getEnv, type Env } from "@/lib/env";
import { checkRedisOwner, IsolationError, type Verdict } from "@/lib/isolation";
import { raiseOpsAlert } from "@/lib/ops-alert";
import { timed } from "@/lib/timing";

/**
 * Rate limiting. Upstash in preview/production (shared across all serverless
 * instances); in-memory for local dev and tests (env validation refuses that
 * when deployed).
 *
 * When Upstash fails (its quota ran out on 2026-11-24, docs/INCIDENTS.md):
 * - sign-in, login emails, the waitlist and admin codes fail closed: refused
 *   with 503, because a per-instance count would hand an attacker one
 *   allowance per server instance;
 * - agent endpoints and buyer limits fall back to each instance's own
 *   counter, so PCs keep working;
 * - either way the owner gets an alert (lib/ops-alert.ts).
 */

export interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix ms when the window resets. */
  reset: number;
  /** The shared limiter is down and this limit fails closed: answer 503, not 429. */
  unavailable?: boolean;
}

export interface Limiter {
  limit(key: string): Promise<LimitResult>;
}

export interface Policy {
  /** Max requests per window. */
  max: number;
  windowSec: number;
  /** Counted by each server instance on its own, never in Upstash. */
  perInstance?: boolean;
}

/** Every rate-limited surface in one place, so SECURITY.md can point here. */
export const POLICIES = {
  loginIp: { max: 10, windowSec: 15 * 60 },
  loginEmail: { max: 3, windowSec: 15 * 60 },
  waitlistIp: { max: 5, windowSec: 60 * 60 },
  quoteUser: { max: 30, windowSec: 60 },
  jobSubmitUser: { max: 10, windowSec: 60 },
  nodeManageUser: { max: 20, windowSec: 60 * 60 },
  accountUser: { max: 5, windowSec: 60 * 60 },
  adminMfaUser: { max: 5, windowSec: 15 * 60 },
  agentNode: { max: 240, windowSec: 60 },
  agentIp: { max: 600, windowSec: 60 },
} as const satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

/** Limits that refuse (503) rather than count per instance when Upstash is down. */
export const FAIL_CLOSED: ReadonlySet<PolicyName> = new Set<PolicyName>(["loginIp", "loginEmail", "waitlistIp", "adminMfaUser"]);

/**
 * The policy in force. Only agentIp can be overridden (AGENT_IP_LIMIT_PER_MIN),
 * and only outside production (env validation refuses it there): the preview
 * load test sends 200 virtual PCs from one runner IP, which this per-IP limit
 * would otherwise answer with 429s it isn't meant for. The override is counted
 * per instance, not in Upstash: it can't fire at that size anyway, and it
 * would cost the load test ~60,000 Upstash commands a run.
 */
export function policyFor(name: PolicyName, env: Pick<Env, "APP_ENV" | "AGENT_IP_LIMIT_PER_MIN">): Policy {
  if (name === "agentIp" && env.AGENT_IP_LIMIT_PER_MIN && env.APP_ENV !== "production") return { max: env.AGENT_IP_LIMIT_PER_MIN, windowSec: 60, perInstance: true };
  return POLICIES[name];
}

/** Fixed-window counter in process memory: dev/test, per-instance policies, and the fallback. */
export class MemoryLimiter implements Limiter {
  private hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly policy: Policy,
    private readonly now: () => number = Date.now,
  ) {}

  async limit(key: string): Promise<LimitResult> {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.reset <= t) {
      entry = { count: 0, reset: t + this.policy.windowSec * 1000 };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return {
      success: entry.count <= this.policy.max,
      limit: this.policy.max,
      remaining: Math.max(0, this.policy.max - entry.count),
      reset: entry.reset,
    };
  }
}

const limiters = new Map<PolicyName, Limiter>();

export interface FallbackOptions {
  /** Refuse (unavailable) instead of counting per instance. */
  failClosed: boolean;
  policy: Policy;
  /** Called once per policy per instance when the shared limiter first fails. */
  onDegraded?: (name: PolicyName, err: unknown) => void;
}

/**
 * Wraps the shared limiter. If it fails (quota, network, or a preview that
 * found production's Redis): fail-closed policies answer "unavailable", the
 * rest use the instance's own counter. Logged once per policy per instance,
 * with the error's name only.
 */
export function withFallback(name: PolicyName, primary: (key: string) => Promise<LimitResult>, fallback: Limiter, opts: FallbackOptions): Limiter {
  let warned = false;
  return {
    async limit(key: string) {
      try {
        return await primary(key);
      } catch (err) {
        if (!warned) {
          warned = true;
          const what = opts.failClosed ? "refusing requests (503) until it's back" : "using this instance's own limiter";
          console.error(`[ratelimit] ${name}: shared limiter failed (${err instanceof Error ? err.name : typeof err}); ${what}`);
          opts.onDegraded?.(name, err);
        }
        if (opts.failClosed) return { success: false, unavailable: true, limit: opts.policy.max, remaining: 0, reset: Date.now() + 30_000 };
        return fallback.limit(key);
      }
    },
  };
}

let redis: Redis | null = null;
function getRedis(env: Env): Redis {
  // One retry, not the client's default five with growing waits (~11 s): a
  // limit check that can't reach Redis goes to the fallback quickly instead.
  redis ??= new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN!, retry: { retries: 1, backoff: () => 50 } });
  return redis;
}

/** How long a limit check may wait for Upstash before it counts as failed. */
export const LIMIT_TIMEOUT_MS = 1500;

class LimiterTimeout extends Error {
  constructor() {
    super("rate limit check timed out");
    this.name = "LimiterTimeout";
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LimiterTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether this deployment may use its Redis (lib/isolation.ts): checked once
 * per instance and again every 10 minutes (two commands at most). A check
 * that errors (Upstash down) is kept for one minute only, then tried again.
 */
let ownerCheck: { until: number; verdict: Promise<Verdict> } | null = null;
export function redisIsolation(now = Date.now()): Promise<Verdict> {
  const env = getEnv();
  if (env.RATE_LIMIT_BACKEND !== "upstash" || (env.APP_ENV !== "preview" && env.APP_ENV !== "production")) return Promise.resolve({ ok: true, owner: null });
  if (ownerCheck && now < ownerCheck.until) return ownerCheck.verdict;
  const appEnv = env.APP_ENV;
  const verdict = checkRedisOwner(getRedis(env), appEnv).then((v) => {
    if (!v.ok) {
      console.error(`[isolation] ${v.reason}`);
      raiseOpsAlert("isolation_redis", { env: appEnv, owner: v.owner ?? "unknown" });
    }
    return v;
  });
  const entry = { until: now + 10 * 60_000, verdict };
  ownerCheck = entry;
  verdict.catch(() => {
    entry.until = now + 60_000;
  });
  return verdict;
}

/** A preview refuses a Redis production owns; production alerts but keeps using its own. */
async function assertRedisUsable(): Promise<void> {
  const v = await redisIsolation();
  if (!v.ok && getEnv().APP_ENV === "preview") throw new IsolationError(v.reason);
}

function onDegraded(name: PolicyName): void {
  raiseOpsAlert(FAIL_CLOSED.has(name) ? "ratelimit_fail_closed" : "ratelimit_fallback", { policy: name, env: getEnv().APP_ENV });
}

export function getLimiter(name: PolicyName): Limiter {
  let l = limiters.get(name);
  if (l) return l;
  const env = getEnv();
  const policy = policyFor(name, env);
  if (env.RATE_LIMIT_BACKEND === "upstash" && !policy.perInstance) {
    const rl = new Ratelimit({
      redis: getRedis(env),
      limiter: Ratelimit.slidingWindow(policy.max, `${policy.windowSec} s`),
      // Each environment has its own database (lib/isolation.ts); the
      // environment stays in the key as well.
      prefix: `ns:rl:${env.APP_ENV}:${name}`,
      analytics: false,
      // The library's own timeout LETS REQUESTS THROUGH when Redis is slow
      // (default 5 s). Off: a slow Redis is a failure like any other (below),
      // so fail-closed limits stay closed.
      timeout: 0,
    });
    const primary = async (key: string): Promise<LimitResult> => {
      const r = await within(
        assertRedisUsable().then(() => rl.limit(key)),
        LIMIT_TIMEOUT_MS,
      );
      if (r.reason === "timeout") throw new LimiterTimeout();
      return { success: r.success, limit: r.limit, remaining: r.remaining, reset: r.reset };
    };
    l = withFallback(name, primary, new MemoryLimiter(policy), { failClosed: FAIL_CLOSED.has(name), policy, onDegraded });
  } else {
    l = new MemoryLimiter(policy);
  }
  limiters.set(name, l);
  return l;
}

export async function checkLimit(name: PolicyName, key: string): Promise<LimitResult> {
  return timed("rl", () => getLimiter(name).limit(key));
}

export function retryAfterSeconds(result: LimitResult, now = Date.now()): number {
  return Math.max(1, Math.ceil((result.reset - now) / 1000));
}

/** 503 for a fail-closed limit while the shared limiter is down. */
export function limiterUnavailable(): Response {
  return Response.json(
    { error: "unavailable", message: "This is briefly unavailable. Try again in a minute." },
    { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } },
  );
}

/** Standard 429 for JSON endpoints (503 if the limit failed closed). */
export function tooManyRequests(result: LimitResult): Response {
  if (result.unavailable) return limiterUnavailable();
  return Response.json(
    { error: "rate_limited", message: "Too many requests. Try again shortly." },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds(result)),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}

/** Test helper. */
export function resetLimiters(): void {
  limiters.clear();
  redis = null;
  ownerCheck = null;
}
