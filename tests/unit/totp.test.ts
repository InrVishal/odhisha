import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, codeForStep, newTotpSecret, otpauthUri, stepAt, totpCode, verifyTotp } from "@/lib/security/totp";

// RFC 6238 appendix B (SHA-1), last 6 of the 8 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const at = (sec: number) => new Date(sec * 1000);

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("matches the RFC test vector at t=%i", (t, code) => {
    expect(totpCode(RFC_SECRET, at(t))).toBe(code);
  });

  it("base32 round-trips any bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (b) => base32Decode(base32Encode(b)).equals(Buffer.from(b))));
  });

  it("new secrets are 160 random bits, different every time", () => {
    const a = newTotpSecret();
    expect(base32Decode(a)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(a);
  });

  it("accepts the current step and one either side, nothing further", () => {
    const now = at(1_800_000_000);
    const s = stepAt(now);
    for (const d of [-1, 0, 1]) expect(verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, s + d), now, null)).toBe(s + d);
    for (const d of [-3, -2, 2, 3]) expect(verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, s + d), now, null)).toBeNull();
  });

  it("a code can't be used twice, or after a newer one", () => {
    const now = at(1_800_000_000);
    const s = stepAt(now);
    const code = codeForStep(RFC_SECRET, s);
    expect(verifyTotp(RFC_SECRET, code, now, null)).toBe(s);
    expect(verifyTotp(RFC_SECRET, code, now, s)).toBeNull();
    expect(verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, s - 1), now, s)).toBeNull();
  });

  it.each(["", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦"])("rejects a malformed code %j", (code) => {
    expect(verifyTotp(RFC_SECRET, code, at(1_800_000_000), null)).toBeNull();
  });

  it("the otpauth link carries the secret and the standard settings", () => {
    const u = new URL(otpauthUri("ABC234", "admin@example.in"));
    expect(u.protocol).toBe("otpauth:");
    expect(u.searchParams.get("secret")).toBe("ABC234");
    expect(u.searchParams.get("digits")).toBe("6");
    expect(u.searchParams.get("period")).toBe("30");
    expect(decodeURIComponent(u.pathname)).toContain("NightShift:admin@example.in");
  });
});
