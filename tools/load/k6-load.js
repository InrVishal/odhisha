/**
 * k6 load test: 200 virtual users, each an owner whose agent heartbeats,
 * leases, works and hands in, and a buyer who quotes and confirms jobs (so
 * there is real work to lease). Pass: p95 under 300 ms on quote, lease,
 * heartbeat and hand-in, fewer than 1% failed requests, 99% of checks ok.
 *
 *   k6 run -e BASE_URL=http://127.0.0.1:3400 -e SEED_FILE=load-seed.json tools/load/k6-load.js
 *
 * Pacing: one round every ~6 s per user (an agent polls every 10 s; this is
 * busier), which stays under the per-account limits (10 job submits a
 * minute), so the numbers are for served requests, not 429s.
 */
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import { SharedArray } from "k6/data";
import encoding from "k6/encoding";
import http from "k6/http";

const seed = new SharedArray("seed", () => JSON.parse(open(__ENV.SEED_FILE)));
const BASE = __ENV.BASE_URL;

export const options = {
  scenarios: {
    // 20 s at 20 users first, so the server's first requests (route compiles,
    // pool connections) don't count. Only the "agents" scenario is measured.
    warmup: { executor: "constant-vus", vus: 20, duration: "20s", gracefulStop: "5s" },
    agents: { executor: "constant-vus", vus: Number(__ENV.VUS || 200), duration: __ENV.DURATION || "3m", startTime: "25s", gracefulStop: "30s" },
  },
  thresholds: {
    "http_req_duration{name:quote,scenario:agents}": ["p(95)<300"],
    "http_req_duration{name:lease,scenario:agents}": ["p(95)<300"],
    "http_req_duration{name:heartbeat,scenario:agents}": ["p(95)<300"],
    "http_req_duration{name:hand-in,scenario:agents}": ["p(95)<300"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
};

/** A deterministic "embedding" per text, so two PCs checking each other agree. */
function vec(text) {
  const bytes = new Uint8Array(crypto.sha256(text, "binary"));
  const v = new Array(384);
  for (let j = 0; j < 384; j++) v[j] = bytes[j % 32] / 255 - 0.5 + j / 10000;
  return v;
}

export default function round() {
  const me = seed[(__VU - 1) % seed.length];
  const agent = { authorization: `Bearer ${me.token}`, "content-type": "application/json", "x-real-ip": me.ip };
  const buyer = { cookie: me.cookie, origin: BASE, "content-type": "application/json", "x-real-ip": me.ip };

  const hb = http.post(`${BASE}/api/agent/heartbeat`, JSON.stringify({ watts: 65, wattsSource: "estimated", deviceId: me.deviceId }), { headers: agent, tags: { name: "heartbeat" } });
  check(hb, { "heartbeat 200": (r) => r.status === 200 });

  const texts = [0, 1, 2].map((k) => `vu ${__VU} round ${__ITER} line ${k}: my order came late, please help with a refund`);
  const q = http.post(`${BASE}/api/jobs/quote`, JSON.stringify({ workloadType: "text_embeddings", gpuClass: "cpu", params: {}, texts }), { headers: buyer, tags: { name: "quote" } });
  check(q, { "quote 201": (r) => r.status === 201 });
  if (q.status === 201) {
    const id = q.json("job.id");
    const c = http.post(`${BASE}/api/jobs/${id}/confirm`, null, { headers: buyer, tags: { name: "confirm" } });
    check(c, { "confirm 200": (r) => r.status === 200 });
  }

  const l = http.post(`${BASE}/api/agent/lease`, "{}", { headers: agent, tags: { name: "lease" } });
  check(l, { "lease 200": (r) => r.status === 200 });
  if (l.status === 200 && l.json("task")) {
    const task = JSON.parse(l.json("task.task"));
    const input = JSON.parse(encoding.b64decode(l.json("input"), "std", "s"));
    const out = JSON.stringify({ items: input.texts.map(vec) });
    const done = http.post(`${BASE}/api/agent/fragments/${task.taskId}/complete`, out, {
      headers: { ...agent, "x-lease-attempt": String(task.attempt), "x-output-sha256": crypto.sha256(out, "hex") },
      tags: { name: "hand-in" },
    });
    check(done, { "hand-in 200": (r) => r.status === 200 });
  }
  sleep(5 + Math.random());
}
