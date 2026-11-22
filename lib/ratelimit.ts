import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getEnv } from "@/lib/env";

/**
 * Rate limiting. Upstash in preview/production (shared across all serverless
 * instances). An in-memory fallback exists for local dev and tests only;
 * env validation refuses it when deployed.
 */

export interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix ms when the window resets. */
  reset: number;
}

export interface Limiter {
  limit(key: string): Promise<LimitResult>;
}

export interface Policy {
  /** Max requests per window. */
  max: number;
  windowSec: number;
}

/** Every rate-limited surface in one place, so SECURITY.md can point here. */
export const POLICIES = {
  loginIp: { max: 10, windowSec: 15 * 60 },
  loginEmail: { max: 3, windowSec: 15 * 60 },
  waitlistIp: { max: 5, windowSec: 60 * 60 },
  quoteUser: { max: 30, windowSec: 60 },
  jobSubmitUser: { max: 10, windowSec: 60 },
  agentNode: { max: 240, windowSec: 60 },
  agentIp: { max: 600, windowSec: 60 },
} as const satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

/** Fixed-window counter in process memory. Dev/test only. */
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

export function getLimiter(name: PolicyName): Limiter {
  let l = limiters.get(name);
  if (l) return l;
  const env = getEnv();
  const policy = POLICIES[name];
  if (env.RATE_LIMIT_BACKEND === "upstash") {
    const rl = new Ratelimit({
      redis: new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN! }),
      limiter: Ratelimit.slidingWindow(policy.max, `${policy.windowSec} s`),
      prefix: `ns:rl:${name}`,
      analytics: false,
    });
    l = { limit: (key) => rl.limit(key) };
  } else {
    l = new MemoryLimiter(policy);
  }
  limiters.set(name, l);
  return l;
}

export async function checkLimit(name: PolicyName, key: string): Promise<LimitResult> {
  return getLimiter(name).limit(key);
}

export function retryAfterSeconds(result: LimitResult, now = Date.now()): number {
  return Math.max(1, Math.ceil((result.reset - now) / 1000));
}

/** Standard 429 for JSON endpoints. */
export function tooManyRequests(result: LimitResult): Response {
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
}
