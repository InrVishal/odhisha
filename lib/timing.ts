import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request timing for the preview load test (SERVER_TIMING=1; env
 * validation refuses it in production). Adds a Server-Timing header:
 *
 *   rl;dur=<ms>;desc="<n> calls"     rate-limit checks (Upstash), summed
 *   db;dur=<ms>;desc="<n> queries"   database round trips (Neon), summed
 *   total;dur=<ms>                   the whole route, inside the function
 *
 * so the load test can split a request's time into rate limits, database,
 * the app's own work (total - rl - db), and what happens outside the
 * function (network, Vercel's edge, cold starts: k6's time - total).
 * Durations and counts only: nothing about the request's content.
 */
export interface Timings {
  rlMs: number;
  rlCalls: number;
  dbMs: number;
  dbQueries: number;
}

const store = new AsyncLocalStorage<Timings>();
// Set while a timed call runs, so a call nested in it (pg's pool.query borrows
// a client and calls client.query) isn't counted twice. Parallel calls each
// get their own context, so they're all counted.
const inside = new AsyncLocalStorage<"rl" | "db">();

/** True when this deployment reports Server-Timing (the load-test preview only). */
export function serverTimingEnabled(): boolean {
  return process.env.SERVER_TIMING === "1" && process.env.VERCEL_ENV !== "production";
}

export async function timed<T>(kind: "rl" | "db", fn: () => Promise<T>): Promise<T> {
  const t = store.getStore();
  if (!t || inside.getStore() === kind) return fn();
  const start = performance.now();
  try {
    return await inside.run(kind, fn);
  } finally {
    const ms = performance.now() - start;
    if (kind === "rl") {
      t.rlMs += ms;
      t.rlCalls += 1;
    } else {
      t.dbMs += ms;
      t.dbQueries += 1;
    }
  }
}

export function serverTimingHeader(t: Timings, totalMs: number): string {
  return `rl;dur=${t.rlMs.toFixed(1)};desc="${t.rlCalls} calls", db;dur=${t.dbMs.toFixed(1)};desc="${t.dbQueries} queries", total;dur=${totalMs.toFixed(1)}`;
}

/** Runs a route, adding Server-Timing when enabled. */
export async function withServerTiming(fn: () => Promise<Response>): Promise<Response> {
  if (!serverTimingEnabled()) return fn();
  const t: Timings = { rlMs: 0, rlCalls: 0, dbMs: 0, dbQueries: 0 };
  const start = performance.now();
  const res = await store.run(t, fn);
  const out = new Response(res.body, res);
  out.headers.set("Server-Timing", serverTimingHeader(t, performance.now() - start));
  return out;
}

type Queryable = { query: (...args: unknown[]) => unknown };
type Connectable = Queryable & { connect: (...args: unknown[]) => Promise<unknown> };
const TIMED = Symbol("timed");

function timeQueries(client: Queryable): void {
  const c = client as Queryable & { [TIMED]?: true };
  if (c[TIMED]) return;
  const query = c.query.bind(c);
  c.query = (...args: unknown[]) => timed("db", async () => query(...args));
  c[TIMED] = true;
}

/** Times every query on a pool, including those on clients it hands out (transactions). */
export function timePool(pool: Connectable): void {
  timeQueries(pool);
  const connect = pool.connect.bind(pool);
  pool.connect = async (...args: unknown[]) => {
    const client = await connect(...args);
    if (client && typeof (client as Queryable).query === "function") timeQueries(client as Queryable);
    return client;
  };
}
