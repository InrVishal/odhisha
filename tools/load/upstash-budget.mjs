/**
 * How many Upstash commands one k6 run (tools/load/k6-load.js) will use, worked
 * out before it starts (incident 2026-11-24: four runs used up the month).
 *
 * Per round, each virtual user makes 5 requests: heartbeat, quote, confirm,
 * lease, hand-in. Each checks one shared limit in Upstash (the agent's token,
 * or the buyer's account); the per-IP agent limit is per instance in load tests
 * (lib/ratelimit.ts). A sliding-window check costs EVAL + GET + GET + INCR = 4
 * commands, plus PEXPIRE on a key's first request in a window = 5
 * (upstash.com/docs/redis/sdks/ratelimit-ts/costs). At ~8 rounds a minute per
 * user that averages ~4.1. Measured runs took ~7.5 s a round (6.2-6.8 s pause
 * plus five requests); 7 s is used here, so the estimate errs high, and then 10%
 * is added on top.
 */
export const LIMIT_CHECKS_PER_ROUND = 5;
export const COMMANDS_PER_CHECK = 4.1;
export const ROUND_SEC = 7;
export const MARGIN = 1.1;
/** k6-load.js: 20 users for 20 s before the measured scenario. */
export const WARMUP = { vus: 20, sec: 20 };

export function parseDuration(d) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(d).trim());
  if (!m) throw new Error(`can't read duration "${d}"`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] ?? "s"];
}

export function estimateCommands({ vus = 200, duration = "3m" } = {}) {
  const rounds = (vus * parseDuration(duration) + WARMUP.vus * WARMUP.sec) / ROUND_SEC;
  return Math.ceil(rounds * LIMIT_CHECKS_PER_ROUND * COMMANDS_PER_CHECK * MARGIN);
}

/** The rule the owner set: a run may use at most 25% of what's left this month. */
export const MAX_SHARE_OF_REMAINING = 0.25;

export function judgeBudget({ estimate, used, limit }) {
  const remaining = Math.max(0, limit - used);
  const allowed = Math.floor(remaining * MAX_SHARE_OF_REMAINING);
  return { remaining, allowed, ok: estimate <= allowed };
}
