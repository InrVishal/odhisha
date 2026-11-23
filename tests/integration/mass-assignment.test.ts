import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as H from "@/lib/api/handlers";
import { jobs, nodes, users } from "@/lib/db/schema";
import { waitlistInput } from "@/lib/waitlist";
import { agentReq, beat, body, harness, makeSession, makeUser, ORIGIN, quoteTexts, registerNode, type Harness } from "../helpers/coordinator";
import { freshDb, type TestDb } from "../helpers/db";

/**
 * A1: no route, server action or form can set role, admin, trust or who owns
 * what. Every JSON body is a strict schema, so an extra field is a 400 and
 * nothing is written. Routes without a body ignore one. Afterwards the
 * database is checked: nothing changed.
 */

/** Extra fields, as raw JSON text (so "__proto__" is sent as a real key, the way an attacker would). */
const EXTRA = [
  `"role":"admin"`,
  `"isAdmin":true`,
  `"admin":true`,
  `"trust":1000`,
  `"trustScore":1000`,
  `"ownerId":"someone-else"`,
  `"buyerId":"someone-else"`,
  `"userId":"someone-else"`,
  `"status":"online"`,
  `"__proto__":{"role":"admin"}`,
  `"constructor":{"prototype":{"role":"admin"}}`,
];

let t: TestDb;
let h: Harness;
let buyer: Awaited<ReturnType<typeof makeUser>>;
let owner: Awaited<ReturnType<typeof makeUser>>;
let nodeId: string;
let token: string;
let jobId: string;

beforeAll(async () => {
  t = await freshDb();
  h = harness(t.db);
  buyer = await makeUser(h.db, "buyer@example.in");
  owner = await makeUser(h.db, "owner@example.in");
  ({ nodeId, token } = await registerNode(h, owner, { name: "PC" }));
  await beat(h, token);
  jobId = (await body<{ job: { id: string } }>(await quoteTexts(h, buyer, 3))).job.id;
});
afterAll(async () => t?.cleanup());

/** The state an attacker would want to change. */
async function snapshot() {
  const u = await h.db.select({ id: users.id, role: users.role }).from(users);
  const n = (await h.db.select({ ownerId: nodes.ownerId, trust: nodes.trustScore, status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId)))[0];
  const j = (await h.db.select({ buyerId: jobs.buyerId, status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)))[0];
  return JSON.stringify({ u, n, j });
}

function raw(method: string, p: string, json: string, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + p, { method, headers: { origin: ORIGIN, host: new URL(ORIGIN).host, "content-type": "application/json", ...headers }, body: json });
}
const withExtra = (base: Record<string, unknown>, ...extra: string[]) =>
  `{${[...Object.entries(base).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`), ...extra].join(",")}}`;

describe("JSON bodies are strict: extra fields are refused and nothing changes", () => {
  const cases: Array<[string, (json: string) => Promise<Response>, Record<string, unknown>]> = [
    ["POST /api/jobs/quote", (j) => H.quoteHandler(raw("POST", "/api/jobs/quote", j), h.as(buyer)), { workloadType: "text_embeddings", gpuClass: "rtx4070", params: {}, texts: ["a"] }],
    ["POST /api/jobs/[id]/confirm", (j) => H.confirmJobHandler(raw("POST", `/api/jobs/${jobId}/confirm`, j), h.as(buyer), jobId), { payWith: "money" }],
    ["POST /api/nodes", (j) => H.registerNodeHandler(raw("POST", "/api/nodes", j), h.as(owner)), { name: "New PC", gpuClass: "rtx4070" }],
    ["PATCH /api/nodes/[id]", (j) => H.updateNodeHandler(raw("PATCH", `/api/nodes/${nodeId}`, j), h.as(owner), nodeId), { paused: false }],
    ["POST /api/account/upi", (j) => H.linkUpiHandler(raw("POST", "/api/account/upi", j), h.as(owner)), { upiId: "owner@okaxis" }],
    ["DELETE /api/account", (j) => H.deleteAccountHandler(raw("DELETE", "/api/account", j), h.as(owner)), { confirm: "DELETE" }],
    [
      "POST /api/agent/heartbeat",
      (j) => H.heartbeatHandler(new Request(`${ORIGIN}/api/agent/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: j }), h.deps),
      { watts: 200, wattsSource: "nvidia-smi" },
    ],
  ];

  for (const [name, send, base] of cases) {
    it(`${name}: role, isAdmin, trust, ownerId, __proto__ ... → 400`, async () => {
      const before = await snapshot();
      for (const extra of EXTRA) {
        const json = withExtra(base, extra);
        const res = await send(json);
        expect(res.status, `${name} with ${json}`).toBe(400);
        expect((await res.json()).error).toBe("invalid_input");
      }
      expect(await snapshot()).toBe(before);
      // Nothing anywhere picked up a polluted prototype.
      expect(({} as Record<string, unknown>).role).toBeUndefined();
    });
  }

  it("multipart image quotes: the request field is strict too", async () => {
    const form = new FormData();
    form.set("request", JSON.stringify({ workloadType: "image_resize", gpuClass: "rtx4070", params: {}, role: "admin" }));
    const req = new Request(`${ORIGIN}/api/jobs/quote`, { method: "POST", headers: { origin: ORIGIN, host: new URL(ORIGIN).host }, body: form });
    expect((await H.quoteHandler(req, h.as(buyer))).status).toBe(400);
  });

  it("agent fail reports are strict", async () => {
    const before = await snapshot();
    const res = await H.failHandler(agentReq(token, "/api/agent/fragments/x/fail", { attempt: 1, reason: "other", trustScore: 1000 }), h.deps, "x");
    expect(res.status).toBe(400);
    expect(await snapshot()).toBe(before);
  });
});

describe("routes without a body ignore one", () => {
  it("cancel, rotate token, revoke and admin release with a role/trust body change nothing they shouldn't", async () => {
    const before = await snapshot();
    const junk = withExtra({}, ...EXTRA);
    await H.rotateTokenHandler(raw("POST", `/api/nodes/${nodeId}/token`, junk), h.as(owner), nodeId);
    const s = await makeSession(h, buyer.id);
    expect((await H.releaseNodeHandler(raw("POST", `/api/admin/nodes/${nodeId}/release`, junk), h.as(buyer, s), nodeId)).status).toBe(404);
    expect(await snapshot()).toBe(before);
    // A heartbeat or lease with the new token still can't claim trust.
    expect((await h.db.select({ t: nodes.trustScore }).from(nodes).where(eq(nodes.id, nodeId)))[0]!.t).toBe(500);
  });
});

describe("forms (server actions) take only the fields they name", () => {
  it("the waitlist schema is strict", () => {
    expect(waitlistInput.safeParse({ email: "a@example.in", interest: "owner", consent: "on", role: "admin" }).success).toBe(false);
    expect(waitlistInput.safeParse({ email: "a@example.in", interest: "owner", consent: "on" }).success).toBe(true);
  });
});

describe("no code can write the role column", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  }
  it("nothing in app/ or lib/ puts role (or isAdmin) into an insert or update", () => {
    const root = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    for (const f of [...files(path.join(root, "app")), ...files(path.join(root, "lib"))]) {
      if (f.endsWith(path.join("lib", "db", "schema.ts"))) continue;
      const src = readFileSync(f, "utf8");
      if (/\.(set|values)\(\s*\{[^}]*\b(role|isAdmin)\b/s.test(src) || /role\s*:\s*["']admin["']/.test(src)) offenders.push(path.relative(root, f));
    }
    expect(offenders).toEqual([]);
  });
});
