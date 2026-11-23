import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkRate, extraCheckChance, NEW_PC_PIECES, NEW_PC_RATE, START_TRUST, TRUSTED_AT, VERIFY_RATE } from "@/lib/coordinator/verify";

describe("how often a PC's pieces are re-run", () => {
  it("a new PC: 50% of its first 20 pieces, whatever its trust", () => {
    expect(NEW_PC_PIECES).toBe(20);
    expect(NEW_PC_RATE).toBe(0.5);
    for (let done = 0; done < 20; done++) {
      expect(checkRate({ piecesDone: done, trustScore: 500 })).toBe(0.5);
      expect(checkRate({ piecesDone: done, trustScore: 1000 })).toBe(0.5);
    }
  });

  it("after 20 pieces it falls with trust: 500 → 50%, 700 → 30%, 900 → 10%", () => {
    expect(checkRate({ piecesDone: 20, trustScore: START_TRUST })).toBe(0.5);
    expect(checkRate({ piecesDone: 20, trustScore: 700 })).toBeCloseTo(0.3, 10);
    expect(checkRate({ piecesDone: 20, trustScore: TRUSTED_AT })).toBeCloseTo(0.1, 10);
    expect(checkRate({ piecesDone: 500, trustScore: 1000 })).toBeCloseTo(0.1, 10);
  });

  it("never below 10%; a PC whose trust drops back is at 50% again", () => {
    expect(checkRate({ piecesDone: 100, trustScore: 450 })).toBe(0.5);
    expect(checkRate({ piecesDone: 100, trustScore: 250 })).toBe(0.5);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 1000 }), (piecesDone, trustScore) => {
        const r = checkRate({ piecesDone, trustScore });
        expect(r).toBeGreaterThanOrEqual(VERIFY_RATE - 1e-12);
        expect(r).toBeLessThanOrEqual(NEW_PC_RATE);
      }),
    );
  });

  it("property: more trust never means more checks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 10_000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), (p, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(checkRate({ piecesDone: p, trustScore: hi })).toBeLessThanOrEqual(checkRate({ piecesDone: p, trustScore: lo }));
      }),
    );
  });

  it("the extra chance on top of the 10% picked at confirm time brings the total to the PC's rate", () => {
    for (const rate of [0.1, 0.3, 0.5]) {
      const total = VERIFY_RATE + (1 - VERIFY_RATE) * extraCheckChance(rate);
      expect(total).toBeCloseTo(rate, 10);
    }
    expect(extraCheckChance(0)).toBe(0);
    expect(extraCheckChance(0.05)).toBe(0);
  });
});
