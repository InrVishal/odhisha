import { expect, test } from "@playwright/test";

/**
 * Coordinator API smoke tests, run against every preview. The job lifecycle
 * itself is covered by the integration suite against a real Postgres; this
 * checks the deployed routes, keys and guards are wired up.
 */

test("publishes the task-signing public key", async ({ request }) => {
  const res = await request.get("/api/agent/signing-key");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.alg).toBe("Ed25519");
  expect(body.kid).toMatch(/^[0-9a-f]{16}$/);
  expect(body.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE/);
});

test("buyer and owner endpoints need a session", async ({ request }) => {
  for (const path of ["/api/jobs", "/api/nodes", "/api/earnings"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
    expect(res.headers()["cache-control"]).toBe("no-store");
  }
});

test("agent endpoints need a valid node token", async ({ request }) => {
  const res = await request.post("/api/agent/lease", { headers: { authorization: "Bearer nsn_" + "A".repeat(43) } });
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("bad_token");
});

test("the scheduler tick needs the cron secret", async ({ request }) => {
  expect((await request.get("/api/cron/tick")).status()).toBe(401);
  expect((await request.get("/api/cron/tick", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
});

test("API responses carry the deny-all CSP and never a stack trace", async ({ request }) => {
  const res = await request.post("/api/agent/heartbeat", { headers: { authorization: "Bearer junk", "content-type": "application/json" }, data: "{" });
  expect(res.headers()["content-security-policy"]).toMatch(/default-src 'none'/);
  const text = await res.text();
  expect(text).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
});
