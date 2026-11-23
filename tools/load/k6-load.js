/**
 * k6 load test: 200 virtual users, each an owner whose agent heartbeats,
 * leases, works and hands in, and a buyer who quotes and confirms jobs (so
 * there is real work to lease).
 *
 *   k6 run -e BASE_URL=http://127.0.0.1:3400 -e SEED_FILE=$PWD/load-seed.json tools/load/k6-load.js
 *
 * BASE_URLS (comma-separated) spreads the users over several app processes,
 * the way Vercel spreads requests over instances; each user sticks to one.
 *
 * Pass (only the measured "agents" scenario counts):
 * - p95 under 300 ms on quote, lease, heartbeat and hand-in, counting
 *   successful responses only (a fast 429 or 500 must not make p95 look good);
 * - under 1% of requests fail (any non-2xx, or no response);
 * - no 429 anywhere: pacing keeps every user under every limit, so a 429
 *   means a limit fired where it shouldn't (counted per endpoint);
 * - no 5xx.
 *
 * Pacing: one round every ~6.5 s per user (a real agent waits 5-7.5 s between
 * polls; this is as busy). Each user starts at a random point in that cycle,
 * as real PCs do (they switch on at different times and jitter their polls):
 * the same request rate, without all 200 firing in the same instant every
 * round (a lockstep herd the real agent avoids). At least 6.2 s between rounds keeps confirm under its limit of
 * 10 job submits a minute, so the numbers are for served requests, not 429s.
 */
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import { SharedArray } from "k6/data";
import encoding from "k6/encoding";
import exec from "k6/execution";
import http from "k6/http";
import { Counter } from "k6/metrics";

const seed = new SharedArray("seed", () => JSON.parse(open(__ENV.SEED_FILE)));
const BASES = (__ENV.BASE_URLS || __ENV.BASE_URL).split(",");
// Vercel Deployment Protection bypass for the preview (never logged by k6).
const BYPASS = __ENV.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": __ENV.VERCEL_AUTOMATION_BYPASS_SECRET } : {};
const ENDPOINTS = ["heartbeat", "quote", "confirm", "lease", "hand-in"];

const rateLimited = new Counter("responses_429");
const serverErrors = new Counter("responses_5xx");
const otherFailures = new Counter("responses_other_failed");

const perEndpoint = {};
for (const name of ENDPOINTS) {
  perEndpoint[`responses_429{name:${name},scenario:agents}`] = ["count==0"];
  perEndpoint[`responses_5xx{name:${name},scenario:agents}`] = ["count==0"];
  perEndpoint[`responses_other_failed{name:${name},scenario:agents}`] = ["count>=0"];
}
// JUDGE_LATENCY=0: errors, 429s and 5xx still fail the run, but p95 is only
// reported. Used for the CI-local run, where app, Postgres and k6 share one
// runner, so its timings describe that runner, not the app. The preview run
// (load-preview.yml) is judged on p95.
const judge = __ENV.JUDGE_LATENCY !== "0";
const p95 = {};
for (const name of ["quote", "lease", "heartbeat", "hand-in"]) {
  // Successful responses only.
  p95[`http_req_duration{name:${name},scenario:agents,expected_response:true}`] = [judge ? "p(95)<300" : "p(95)>=0"];
  // All responses, reported (not judged) for comparison.
  p95[`http_req_duration{name:${name},scenario:agents}`] = ["p(95)>=0"];
}
// Confirm (the buyer's "pay" step) is reported too, so its count is in the summary.
p95["http_req_duration{name:confirm,scenario:agents}"] = ["p(95)>=0"];

export const options = {
  scenarios: {
    // 20 s at 20 users first, so the server's first requests (route loads,
    // pool connections) don't count. Only the "agents" scenario is measured.
    warmup: { executor: "constant-vus", vus: 20, duration: "20s", gracefulStop: "5s" },
    agents: { executor: "constant-vus", vus: Number(__ENV.VUS || 200), duration: __ENV.DURATION || "3m", startTime: "25s", gracefulStop: "30s" },
  },
  thresholds: {
    ...p95,
    "http_req_failed{scenario:agents}": ["rate<0.01"],
    "checks{scenario:agents}": ["rate>0.99"],
    ...perEndpoint,
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
};

/** Counts each failed response by kind, tagged with its endpoint. */
function tally(res, name) {
  const tags = { name };
  if (res.status === 429) rateLimited.add(1, tags);
  else if (res.status >= 500) serverErrors.add(1, tags);
  else if (res.status === 0 || res.status >= 300) otherFailures.add(1, tags);
  return res;
}

/** A deterministic "embedding" per text, so two PCs checking each other agree. */
function vec(text) {
  const bytes = new Uint8Array(crypto.sha256(text, "binary"));
  const v = new Array(384);
  for (let j = 0; j < 384; j++) v[j] = bytes[j % 32] / 255 - 0.5 + j / 10000;
  return v;
}

export default function round() {
  const me = seed[(__VU - 1) % seed.length];
  const BASE = BASES[(__VU - 1) % BASES.length];
  if (exec.vu.iterationInScenario === 0) sleep(Math.random() * 6.5);
  // x-real-ip gives each virtual PC its own address locally; Vercel replaces it
  // with the runner's real address.
  const agent = { ...BYPASS, authorization: `Bearer ${me.token}`, "content-type": "application/json", "x-real-ip": me.ip };
  const buyer = { ...BYPASS, cookie: me.cookie, origin: BASE, "content-type": "application/json", "x-real-ip": me.ip };

  const hb = tally(http.post(`${BASE}/api/agent/heartbeat`, JSON.stringify({ watts: 65, wattsSource: "estimated", deviceId: me.deviceId }), { headers: agent, tags: { name: "heartbeat" } }), "heartbeat");
  check(hb, { "heartbeat 200": (r) => r.status === 200 });

  const texts = [0, 1, 2].map((k) => `vu ${__VU} round ${__ITER} line ${k}: my order came late, please help with a refund`);
  const q = tally(http.post(`${BASE}/api/jobs/quote`, JSON.stringify({ workloadType: "text_embeddings", gpuClass: "cpu", params: {}, texts }), { headers: buyer, tags: { name: "quote" } }), "quote");
  check(q, { "quote 201": (r) => r.status === 201 });
  if (q.status === 201) {
    const id = q.json("job.id");
    const c = tally(http.post(`${BASE}/api/jobs/${id}/confirm`, null, { headers: buyer, tags: { name: "confirm" } }), "confirm");
    check(c, { "confirm 200": (r) => r.status === 200 });
  }

  const l = tally(http.post(`${BASE}/api/agent/lease`, "{}", { headers: agent, tags: { name: "lease" } }), "lease");
  check(l, { "lease 200": (r) => r.status === 200 });
  if (l.status === 200 && l.json("task")) {
    const task = JSON.parse(l.json("task.task"));
    const input = JSON.parse(encoding.b64decode(l.json("input"), "std", "s"));
    const out = JSON.stringify({ items: input.texts.map(vec) });
    const done = tally(
      http.post(`${BASE}/api/agent/fragments/${task.taskId}/complete`, out, {
        headers: { ...agent, "x-lease-attempt": String(task.attempt), "x-output-sha256": crypto.sha256(out, "hex") },
        tags: { name: "hand-in" },
      }),
      "hand-in",
    );
    check(done, { "hand-in 200": (r) => r.status === 200 });
  }
  sleep(6.2 + Math.random() * 0.6);
}
