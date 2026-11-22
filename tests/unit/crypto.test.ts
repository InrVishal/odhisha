import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { newDataKey, open, seal, unwrapKey, wrapKey } from "@/lib/security/envelope";
import { loadKeys } from "@/lib/security/keys";
import { keyId, newNonce, sha256Hex, signTask, verifySignedTask, type Task } from "@/lib/security/signing";

const master = randomBytes(32);

describe("envelope encryption (per-fragment keys)", () => {
  it("round-trips and binds the ciphertext to its AAD", () => {
    const key = randomBytes(32);
    const sealed = seal(key, Buffer.from("hello"), "blob:a");
    expect(open(key, sealed, "blob:a").toString()).toBe("hello");
    expect(() => open(key, sealed, "blob:b")).toThrow("could not decrypt");
    expect(() => open(randomBytes(32), sealed, "blob:a")).toThrow("could not decrypt");
  });

  it("detects any flipped bit", () => {
    const key = randomBytes(32);
    const sealed = seal(key, Buffer.from("secret data"), "x");
    for (const i of [0, 5, 20, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[i]! ^= 1;
      expect(() => open(key, bad, "x")).toThrow();
    }
  });

  it("never stores plaintext and uses a fresh IV every time", () => {
    const key = randomBytes(32);
    const a = seal(key, Buffer.from("same"), "x");
    const b = seal(key, Buffer.from("same"), "x");
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from("same"))).toBe(false);
  });

  it("wraps data keys so they only open for their own fragment", () => {
    const { dataKey, wrapped } = newDataKey(master, "job1/0");
    expect(unwrapKey(master, wrapped, "job1/0").equals(dataKey)).toBe(true);
    expect(() => unwrapKey(master, wrapped, "job1/1")).toThrow();
    expect(() => unwrapKey(randomBytes(32), wrapped, "job1/0")).toThrow();
    expect(() => wrapKey(master, Buffer.alloc(16), "x")).toThrow("32 bytes");
  });

  it("gives every fragment a different key", () => {
    const keys = new Set(Array.from({ length: 50 }, (_, i) => newDataKey(master, `j/${i}`).dataKey.toString("hex")));
    expect(keys.size).toBe(50);
  });

  it("rejects garbage", () => {
    expect(() => open(master, Buffer.from([2, 1, 2]), "x")).toThrow("not a sealed value");
  });
});

describe("signed tasks (Ed25519)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.UTC(2026, 10, 22, 20, 0, 0);
  const task: Task = {
    v: 1,
    taskId: "f1",
    jobId: "j1",
    nodeId: "n1",
    attempt: 1,
    workload: "text_embeddings",
    image: null,
    params: { model: "all-MiniLM-L6-v2" },
    itemCount: 2,
    inputSha256: sha256Hex(Buffer.from("x")),
    iat: now / 1000,
    exp: now / 1000 + 600,
    nonce: newNonce(),
  };

  it("verifies a genuine task", () => {
    const signed = signTask(task, privateKey, publicKey);
    expect(verifySignedTask(signed, publicKey, { nodeId: "n1", now })).toEqual(task);
    expect(signed.kid).toBe(keyId(publicKey));
    expect(signed.kid).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects a tampered task or signature", () => {
    const signed = signTask(task, privateKey, publicKey);
    const tampered = { ...signed, task: signed.task.replace('"attempt":1', '"attempt":2') };
    expect(() => verifySignedTask(tampered, publicKey, { nodeId: "n1", now })).toThrow("bad signature");
    const sig = Buffer.from(signed.signature, "base64");
    sig[0]! ^= 1;
    expect(() => verifySignedTask({ ...signed, signature: sig.toString("base64") }, publicKey, { nodeId: "n1", now })).toThrow(
      "bad signature",
    );
  });

  it("rejects a task signed by another key", () => {
    const other = generateKeyPairSync("ed25519");
    const signed = signTask(task, other.privateKey, other.publicKey);
    expect(() => verifySignedTask(signed, publicKey, { nodeId: "n1", now })).toThrow("bad signature");
  });

  it("rejects expired tasks, tasks for another node, and replayed nonces", () => {
    const signed = signTask(task, privateKey, publicKey);
    expect(() => verifySignedTask(signed, publicKey, { nodeId: "n1", now: now + 601_000 })).toThrow("expired");
    expect(() => verifySignedTask(signed, publicKey, { nodeId: "n2", now })).toThrow("another node");
    const seen = new Set<string>();
    verifySignedTask(signed, publicKey, { nodeId: "n1", now, seenNonces: seen });
    expect(() => verifySignedTask(signed, publicKey, { nodeId: "n1", now, seenNonces: seen })).toThrow("replayed nonce");
  });

  it("makes unique 128-bit nonces", () => {
    const n = new Set(Array.from({ length: 1000 }, newNonce));
    expect(n.size).toBe(1000);
    expect([...n][0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("coordinator keys", () => {
  it("loads keys from the environment", () => {
    const pk = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const keys = loadKeys({ APP_ENV: "production", COORDINATOR_SIGNING_KEY: pk, DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") });
    expect(keys.ephemeral).toBe(false);
    expect(keys.dataKey.length).toBe(32);
    expect(keys.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("uses random keys only in dev and test, never when deployed", () => {
    expect(loadKeys({ APP_ENV: "test", COORDINATOR_SIGNING_KEY: undefined, DATA_ENCRYPTION_KEY: undefined }).ephemeral).toBe(true);
    for (const APP_ENV of ["preview", "production"] as const) {
      expect(() => loadKeys({ APP_ENV, COORDINATOR_SIGNING_KEY: undefined, DATA_ENCRYPTION_KEY: undefined })).toThrow("required");
    }
  });
});

describe("process keys", () => {
  it("are loaded once from the environment and cached", async () => {
    const { getKeys, setKeysForTests } = await import("@/lib/security/keys");
    const { resetEnvCache } = await import("@/lib/env");
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("DATABASE_URL", "pglite:memory");
    vi.stubEnv("AUTH_SECRET", "t".repeat(40));
    vi.stubEnv("CRON_SECRET", "t".repeat(40));
    resetEnvCache();
    setKeysForTests(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await getKeys();
    const b = await getKeys();
    expect(a).toBe(b);
    expect(a.dataKey.length).toBe(32);
    expect(a.ephemeral).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    setKeysForTests(undefined);
    warn.mockRestore();
    vi.unstubAllEnvs();
    resetEnvCache();
  });
});
