import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { Env } from "@/lib/env";

/**
 * The coordinator's two long-lived keys.
 *
 * - signing: Ed25519, signs every task sent to an agent.
 * - dataKey: AES-256, wraps each fragment's own data key.
 *
 * Preview and production must set both (env validation refuses to boot
 * without them). In local dev and tests an unset key is replaced by a random
 * one for the life of the process. That is safe because nothing outlives it:
 * the E2E server uses an in-memory database, and a dev restart only means old
 * local jobs can't be decrypted. Never a fixed key in the source.
 */
export interface CoordinatorKeys {
  signingKey: KeyObject;
  publicKey: KeyObject;
  dataKey: Buffer;
  /** True when a random per-process key was used (dev/test only). */
  ephemeral: boolean;
}

let cached: CoordinatorKeys | undefined;

export function loadKeys(env: Pick<Env, "APP_ENV" | "COORDINATOR_SIGNING_KEY" | "DATA_ENCRYPTION_KEY">): CoordinatorKeys {
  const deployed = env.APP_ENV === "preview" || env.APP_ENV === "production";
  if (deployed && (!env.COORDINATOR_SIGNING_KEY || !env.DATA_ENCRYPTION_KEY)) {
    throw new Error("COORDINATOR_SIGNING_KEY and DATA_ENCRYPTION_KEY are required when deployed");
  }
  let ephemeral = false;
  let signingKey: KeyObject;
  if (env.COORDINATOR_SIGNING_KEY) {
    signingKey = createPrivateKey({ key: Buffer.from(env.COORDINATOR_SIGNING_KEY, "base64"), format: "der", type: "pkcs8" });
  } else {
    signingKey = generateKeyPairSync("ed25519").privateKey;
    ephemeral = true;
  }
  let dataKey: Buffer;
  if (env.DATA_ENCRYPTION_KEY) {
    dataKey = Buffer.from(env.DATA_ENCRYPTION_KEY, "base64");
  } else {
    dataKey = randomBytes(32);
    ephemeral = true;
  }
  return { signingKey, publicKey: createPublicKey(signingKey), dataKey, ephemeral };
}

/** Process-wide keys from the validated environment. */
export async function getKeys(): Promise<CoordinatorKeys> {
  if (!cached) {
    const { getEnv } = await import("@/lib/env");
    cached = loadKeys(getEnv());
    if (cached.ephemeral) {
      console.warn("[nightshift] coordinator keys not set: using random per-process keys (dev/test only)");
    }
  }
  return cached;
}

/** Test helper. */
export function setKeysForTests(keys: CoordinatorKeys | undefined): void {
  cached = keys;
}
