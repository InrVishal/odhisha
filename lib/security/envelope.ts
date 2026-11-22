import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for job data at rest.
 *
 * Every fragment gets its own random 256-bit data key. Its input and output
 * are encrypted with AES-256-GCM under that key. The data key itself is stored
 * only in wrapped form (encrypted with DATA_ENCRYPTION_KEY, also AES-256-GCM),
 * in `fragment.wrapped_key`. A leaked database dump without the env key
 * reveals no job data.
 *
 * Format of every sealed value: version byte (1) | 12-byte IV | 16-byte tag |
 * ciphertext. Associated data binds a ciphertext to what it belongs to, so a
 * blob can't be swapped onto another fragment, and a wrapped key can't be
 * moved to another fragment row.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = 1 + IV_BYTES + TAG_BYTES;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new EnvelopeError("key must be 32 bytes");
}

export function seal(key: Buffer, plaintext: Uint8Array, aad: string): Buffer {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Uint8Array, aad: string): Buffer {
  checkKey(key);
  const buf = Buffer.from(sealed);
  if (buf.length < HEADER || buf[0] !== VERSION) throw new EnvelopeError("not a sealed value");
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, HEADER);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buf.subarray(HEADER)), decipher.final()]);
  } catch {
    // Wrong key, wrong AAD, or tampered bytes. Never say which.
    throw new EnvelopeError("could not decrypt");
  }
}

/** A new random data key, and that key wrapped for storage. */
export function newDataKey(masterKey: Buffer, owner: string): { dataKey: Buffer; wrapped: string } {
  const dataKey = randomBytes(32);
  return { dataKey, wrapped: wrapKey(masterKey, dataKey, owner) };
}

/** `owner` is what the key belongs to (the job and fragment), used as AAD. */
export function wrapKey(masterKey: Buffer, dataKey: Buffer, owner: string): string {
  checkKey(dataKey);
  return seal(masterKey, dataKey, `key:${owner}`).toString("base64");
}

export function unwrapKey(masterKey: Buffer, wrapped: string, owner: string): Buffer {
  const key = open(masterKey, Buffer.from(wrapped, "base64"), `key:${owner}`);
  checkKey(key);
  return key;
}
