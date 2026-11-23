import { createHmac, randomBytes } from "node:crypto";

/**
 * TOTP (RFC 6238): 6 digits, 30-second steps, HMAC-SHA1, the settings every
 * authenticator app uses by default. Pure, no I/O.
 *
 * A code is accepted for the current step or one step either side (clock
 * drift), and only for a step later than the last one used, so a code that
 * was seen (shoulder-surfed, phished, logged) can't be replayed.
 */

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that are still accepted. */
export const TOTP_DRIFT_STEPS = 1;
const SECRET_BYTES = 20;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret, base32 (what authenticator apps take). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SEC);
}

/** The code for one time step (RFC 4226 HOTP with the step as the counter). */
export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpCode(secret: string, now: Date): string {
  return codeForStep(secret, stepAt(now));
}

/**
 * Checks a code. Returns the step it matched (store it as the last used
 * step), or null if it's wrong, malformed, or not newer than `lastStep`.
 */
export function verifyTotp(secret: string, code: string, now: Date, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  let matched: number | null = null;
  // Check every step in the window (no early exit), so timing doesn't say which matched.
  for (let s = current - TOTP_DRIFT_STEPS; s <= current + TOTP_DRIFT_STEPS; s++) {
    if (codeForStep(secret, s) === code && (lastStep === null || s > lastStep)) matched = matched ?? s;
  }
  return matched;
}

/** The otpauth:// link authenticator apps import (as a QR code or a link). */
export function otpauthUri(secret: string, account: string, issuer = "NightShift"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SEC) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
