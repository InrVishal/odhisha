import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildChallenge,
  CHALLENGE_ITEMS,
  CHALLENGE_MIN_GAP_SEC,
  checkChallenge,
  FIRST_CHALLENGE_GAP_SEC,
  medianScore,
  REFERENCE_CHALLENGE_ITEMS_PER_SEC,
  runScore,
  wantsChallenge,
} from "@/lib/coordinator/challenge";

/** Stand-in for the model: normalised sum of per-word vectors (lowercased), like a tiny real embedder. */
function bagOfWords(texts: string[]): number[][] {
  const word = (w: string) => {
    const h = createHash("sha256").update(w).digest();
    return Array.from({ length: 384 }, (_, j) => h[j % 32]! / 255 - 0.5 + Math.sin(j * (h[j % 32]! + 1)) * 0.1);
  };
  return texts.map((t) => {
    const v = Array(384).fill(0) as number[];
    for (const w of t.toLowerCase().split(/\s+/)) word(w).forEach((x, j) => (v[j] = v[j]! + x));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
}
const json = (items: unknown) => Buffer.from(JSON.stringify({ items }));

describe("building a challenge", () => {
  it("has 200 sentences with the hidden structure in random places", () => {
    const { texts, spec } = buildChallenge();
    expect(texts).toHaveLength(CHALLENGE_ITEMS);
    expect(spec.items).toBe(CHALLENGE_ITEMS);
    for (const [a, b] of spec.duplicates) expect(texts[a]).toBe(texts[b]);
    for (const [a, b] of spec.casePairs) expect(texts[b]).toBe(texts[a]!.toUpperCase());
    for (const [s, near, far] of spec.triples) {
      expect(texts[near]!.startsWith(`${texts[s]} `)).toBe(true);
      expect(texts[far]).not.toBe(texts[s]);
    }
    // Two challenges never look the same.
    expect(buildChallenge().texts).not.toEqual(texts);
  });
});

describe("checking a challenge (the canary)", () => {
  const { texts, spec } = buildChallenge();

  it("passes an honest embedder", () => {
    expect(checkChallenge(spec, json(bagOfWords(texts)))).toEqual({ passed: true, failures: [] });
  });

  it("fails random vectors, one constant vector, a per-text hash, and unnormalised output", () => {
    const random = texts.map(() => {
      const v = Array.from({ length: 384 }, () => Math.random() - 0.5);
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
    expect(checkChallenge(spec, json(random)).passed).toBe(false);
    const constant = texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));
    expect(checkChallenge(spec, json(constant)).failures.join()).toMatch(/near sentences/);
    // Hashing the exact text gives equal duplicates but different case copies and no meaning.
    const hashed = bagOfWords(texts.map((t) => createHash("md5").update(t).digest("hex")));
    expect(checkChallenge(spec, json(hashed)).passed).toBe(false);
    const scaled = bagOfWords(texts).map((v) => v.map((x) => x * 3));
    expect(checkChallenge(spec, json(scaled)).failures).toContain("vectors not normalised");
  });

  it("fails malformed output", () => {
    expect(checkChallenge(spec, Buffer.from("nope")).failures).toEqual(["not JSON"]);
    expect(checkChallenge(spec, json([[1]])).failures).toEqual(["wrong item count"]);
    expect(checkChallenge(spec, json(texts.map(() => ["x"]))).failures).toEqual(["not vectors"]);
  });
});

describe("scoring", () => {
  it("puts the reference speed at 1000 and caps the scale", () => {
    expect(runScore(200, (200 / REFERENCE_CHALLENGE_ITEMS_PER_SEC) * 1000)).toBe(1000);
    expect(runScore(200, 8000)).toBe(500);
    expect(runScore(200, 1)).toBe(10_000);
    expect(runScore(0, 100)).toBe(1);
    expect(runScore(200, 0)).toBe(1);
  });

  it("needs three runs, takes the median, and drops runs more than 2× off it", () => {
    const run = (score: number) => ({ items: 200, millis: Math.round((200 * 1000 * 1000) / (score * REFERENCE_CHALLENGE_ITEMS_PER_SEC)) });
    expect(medianScore([run(500), run(520)])).toBeNull();
    expect(medianScore([run(500), run(520), run(480)])).toBe(500);
    // One stalled run and one impossibly fast one are both ignored.
    expect(medianScore([run(500), run(100), run(520), run(4000), run(490)])).toBe(500);
    // Only the 5 most recent count.
    expect(medianScore([run(500), run(500), run(500), run(500), run(500), run(9000), run(9000), run(9000)])).toBe(500);
    // Too much disagreement: no score yet.
    expect(medianScore([run(100), run(1000), run(5000)])).toBeNull();
  });
});

describe("when to send a challenge", () => {
  const now = new Date("2026-11-23T00:00:00Z");
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

  it("sends one on a new PC's first lease, then waits before the next", () => {
    expect(wantsChallenge({ measured: false, lastChallengeAt: null, now })).toBe(true);
    expect(wantsChallenge({ measured: false, lastChallengeAt: ago(60), now })).toBe(false);
    expect(wantsChallenge({ measured: false, lastChallengeAt: ago(FIRST_CHALLENGE_GAP_SEC), now })).toBe(true);
  });

  it("then about 1 lease in 20, at most once an hour", () => {
    expect(wantsChallenge({ measured: true, lastChallengeAt: ago(60), now, rand: () => 0 })).toBe(false);
    expect(wantsChallenge({ measured: true, lastChallengeAt: ago(CHALLENGE_MIN_GAP_SEC), now, rand: () => 0 })).toBe(true);
    expect(wantsChallenge({ measured: true, lastChallengeAt: ago(CHALLENGE_MIN_GAP_SEC), now, rand: () => 1 })).toBe(false);
    expect(wantsChallenge({ measured: true, lastChallengeAt: null, now, rand: () => 0 })).toBe(true);
  });
});
