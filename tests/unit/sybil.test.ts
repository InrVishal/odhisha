import { describe, expect, it } from "vitest";
import { deviceHash, maskUpi, mayCheck, normaliseUpi, subnetHash, subnetOf, upiHash } from "@/lib/coordinator/sybil";

describe("networks", () => {
  it("IPv4 → its /24, IPv6 → its /48, mapped IPv4 like IPv4", () => {
    expect(subnetOf("203.0.113.7")).toBe("203.0.113.0/24");
    expect(subnetOf(" 203.0.113.250 ")).toBe("203.0.113.0/24");
    expect(subnetOf("::ffff:198.51.100.9")).toBe("198.51.100.0/24");
    expect(subnetOf("2001:db8:abcd:12::1")).toBe("2001:0db8:abcd::/48");
    expect(subnetOf("2001:db8::1")).toBe("2001:0db8:0000::/48");
    expect(subnetOf("[2001:db8:1:2:3:4:5:6]")).toBe("2001:0db8:0001::/48");
  });

  it("no usable address, no network (so no rule and no flag)", () => {
    expect(subnetOf("unknown")).toBeNull();
    expect(subnetOf("")).toBeNull();
    expect(subnetOf("999.1.1.1")).toBeNull();
    expect(subnetHash("s", "unknown")).toBeNull();
  });

  it("stores keyed hashes, never the address or ID, and the same input always gives the same hash", () => {
    const a = subnetHash("secret", "203.0.113.7")!;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(subnetHash("secret", "203.0.113.99"));
    expect(a).not.toBe(subnetHash("secret", "203.0.114.7"));
    expect(a).not.toBe(subnetHash("other-secret", "203.0.113.7"));
    const d = "a".repeat(64);
    expect(deviceHash("secret", d)).toBe(deviceHash("secret", d.toUpperCase()));
    expect(deviceHash("secret", d)).not.toContain(d);
  });
});

describe("UPI IDs", () => {
  it("normalises name@handle and refuses anything else", () => {
    expect(normaliseUpi(" Ravi.K@OkAxis ")).toBe("ravi.k@okaxis");
    expect(normaliseUpi("9876543210@ybl")).toBe("9876543210@ybl");
    for (const bad of ["ravi", "@okaxis", "ravi@", "ra vi@okaxis", "ravi@ok-axis", "r@okaxis", "ravi@1bank", "<script>@x"]) expect(normaliseUpi(bad)).toBeNull();
  });

  it("is masked for display and hashed for the one-account rule", () => {
    expect(maskUpi("ravi.k@okaxis")).toBe("ra•••@okaxis");
    expect(upiHash("s", "ravi.k@okaxis")).toBe(upiHash("s", "ravi.k@okaxis"));
    expect(upiHash("s", "ravi.k@okaxis")).not.toBe(upiHash("s", "ravi.k@okicici"));
  });
});

describe("who may check whom", () => {
  const me = { ownerId: "me", deviceHash: "d1", subnetHash: "n1" };
  const other = { ownerId: "them", deviceHash: "d2", subnetHash: "n2" };

  it("never the same account", () => {
    expect(mayCheck(me, [{ ...other, ownerId: "me" }], "enforce")).toBe(false);
    expect(mayCheck(me, [{ ...other, ownerId: "me" }], "report")).toBe(false);
  });

  it("never the same device or network when enforced; report mode only flags them", () => {
    expect(mayCheck(me, [other], "enforce")).toBe(true);
    expect(mayCheck(me, [{ ...other, deviceHash: "d1" }], "enforce")).toBe(false);
    expect(mayCheck(me, [{ ...other, subnetHash: "n1" }], "enforce")).toBe(false);
    expect(mayCheck(me, [{ ...other, subnetHash: "n1" }], "report")).toBe(true);
  });

  it("checks against every PC that ran or checked the piece", () => {
    expect(mayCheck(me, [other, { ownerId: "x", deviceHash: null, subnetHash: "n1" }], "enforce")).toBe(false);
    expect(mayCheck(me, [], "enforce")).toBe(true);
  });

  it("a PC with no known device or network isn't matched on them", () => {
    expect(mayCheck({ ownerId: "me", deviceHash: null, subnetHash: null }, [{ ownerId: "them", deviceHash: null, subnetHash: null }], "enforce")).toBe(true);
  });
});
