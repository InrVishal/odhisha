import { randomInt } from "node:crypto";
import { MAX_BENCHMARK_SCORE } from "@/lib/timebank";
import { cosine } from "./verify";

/**
 * Coordinator challenges: signed text-embedding pieces the coordinator makes
 * up itself, to catch cheating PCs (a canary) and to time them (the
 * benchmark), without trusting anything the PC says about itself.
 *
 * The sentences are random words, so nobody can look the answers up ahead of
 * time. What makes it a canary is the structure hidden inside, which only a
 * real run of the model produces:
 * - exact duplicates must give the same vector;
 * - an UPPERCASE copy must give the same vector (the model is uncased);
 * - a sentence must sit closer to itself with a few words added than to an
 *   unrelated sentence.
 * Random vectors fail the duplicates; a constant or hashed vector fails the
 * near/far test. A PC that runs a different (cheaper) model can pass these,
 * which is what the sampled re-runs on real jobs (verification.ts) are for.
 *
 * Speed comes from the coordinator's own clock: lease issued → result in.
 * That includes container start-up and the network, so a PC can make its
 * score lower (by stalling) but never higher than it really is.
 */

export const CHALLENGE_ITEMS = 200;
const DUPLICATE_PAIRS = 6;
const CASE_PAIRS = 6;
const TRIPLES = 8;
/** Near must beat far in at least this many of the triples. */
const TRIPLES_TO_PASS = 7;

/** Runs needed before a measured score replaces the class default. */
export const MIN_SAMPLES = 3;
/** The score is the median of this many most recent runs (after dropping outliers). */
export const SAMPLE_WINDOW = 5;
/**
 * Estimated end-to-end speed of an RTX 3060 PC on one challenge piece,
 * container start included (items per second). Defines "RTX 3060 = 1000".
 * An estimate until someone times a real RTX 3060, like the agent's old one.
 */
export const REFERENCE_CHALLENGE_ITEMS_PER_SEC = 50;

/** A PC with no measured score gets a challenge on its first lease... */
export const FIRST_CHALLENGE_GAP_SEC = 10 * 60;
/** ...then one in this many leases, at most once an hour. */
export const CHALLENGE_ONE_IN = 20;
export const CHALLENGE_MIN_GAP_SEC = 60 * 60;

const WORDS = (
  "river lamp orange window carpet violin garden pencil mountain ticket ocean candle bridge morning silver " +
  "rocket market forest teacher bottle engine island letter shadow pocket button tiger camera ladder honey " +
  "planet basket feather marble jacket kitchen meadow needle orchard parcel quarry ribbon saddle thunder " +
  "umbrella valley wagon yellow zebra anchor blanket cactus desert empire falcon glacier harbor iceberg jungle " +
  "kettle lantern mirror nectar oyster pepper quilt rabbit sailor tunnel uniform velvet walnut yogurt bamboo " +
  "cotton dragon elbow fountain goblet hammer insect jasmine kingdom lemon monkey noodle olive puzzle quartz " +
  "raven spider tomato utensil village whistle anchor bakery canyon dolphin eagle fabric ginger helmet ivory " +
  "jigsaw kayak library magnet narrow orbit pillow riddle scooter trumpet vacuum wizard cricket monsoon chutney"
).split(" ");

export interface ChallengeSpec {
  v: 1;
  items: number;
  duplicates: Array<[number, number]>;
  casePairs: Array<[number, number]>;
  /** [sentence, near (sentence + words), far (unrelated)] */
  triples: Array<[number, number, number]>;
}

function sentence(rand: (max: number) => number, words: number): string {
  return Array.from({ length: words }, () => WORDS[rand(WORDS.length)]).join(" ");
}

/** Makes one challenge: the texts to send and the hidden structure to check. */
export function buildChallenge(rand: (max: number) => number = randomInt): { texts: string[]; spec: ChallengeSpec } {
  const texts: string[] = [];
  const duplicates: ChallengeSpec["duplicates"] = [];
  const casePairs: ChallengeSpec["casePairs"] = [];
  const triples: ChallengeSpec["triples"] = [];
  const push = (t: string) => texts.push(t) - 1;
  for (let i = 0; i < DUPLICATE_PAIRS; i++) {
    const s = sentence(rand, 6 + rand(6));
    duplicates.push([push(s), push(s)]);
  }
  for (let i = 0; i < CASE_PAIRS; i++) {
    const s = sentence(rand, 6 + rand(6));
    casePairs.push([push(s), push(s.toUpperCase())]);
  }
  for (let i = 0; i < TRIPLES; i++) {
    const s = sentence(rand, 8 + rand(4));
    triples.push([push(s), push(`${s} ${sentence(rand, 2)}`), push(sentence(rand, 8 + rand(4)))]);
  }
  while (texts.length < CHALLENGE_ITEMS) push(sentence(rand, 6 + rand(8)));

  // Shuffle so the structure isn't at fixed positions; remap the indexes.
  const order = texts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const where = new Map(order.map((from, to) => [from, to]));
  const at = (i: number) => where.get(i)!;
  return {
    texts: order.map((i) => texts[i]!),
    spec: {
      v: 1,
      items: CHALLENGE_ITEMS,
      duplicates: duplicates.map(([a, b]) => [at(a), at(b)]),
      casePairs: casePairs.map(([a, b]) => [at(a), at(b)]),
      triples: triples.map(([a, b, c]) => [at(a), at(b), at(c)]),
    },
  };
}

export interface ChallengeResult {
  passed: boolean;
  failures: string[];
}

/** Checks a PC's output against the challenge's hidden structure. */
export function checkChallenge(spec: ChallengeSpec, output: Uint8Array): ChallengeResult {
  const failures: string[] = [];
  let items: number[][];
  try {
    const parsed = JSON.parse(Buffer.from(output).toString("utf8")) as { items?: unknown };
    if (!Array.isArray(parsed.items) || parsed.items.length !== spec.items) return { passed: false, failures: ["wrong item count"] };
    items = parsed.items as number[][];
  } catch {
    return { passed: false, failures: ["not JSON"] };
  }
  if (!items.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)))) {
    return { passed: false, failures: ["not vectors"] };
  }
  const norms = items.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
  if (norms.some((n) => Math.abs(n - 1) > 0.01)) failures.push("vectors not normalised");
  if (!spec.duplicates.every(([a, b]) => cosine(items[a]!, items[b]!) >= 0.9999)) failures.push("duplicate sentences gave different vectors");
  if (!spec.casePairs.every(([a, b]) => cosine(items[a]!, items[b]!) >= 0.999)) failures.push("upper and lower case gave different vectors");
  const ordered = spec.triples.filter(([s, near, far]) => cosine(items[s]!, items[near]!) > cosine(items[s]!, items[far]!)).length;
  if (ordered < TRIPLES_TO_PASS) failures.push(`near sentences not closer than unrelated ones (${ordered}/${spec.triples.length})`);
  return { passed: failures.length === 0, failures };
}

/** One run's score on the RTX 3060 = 1000 scale, from the coordinator's own timing. */
export function runScore(items: number, millis: number): number {
  if (items <= 0 || millis <= 0) return 1;
  const perSec = (items * 1000) / millis;
  return Math.max(1, Math.min(MAX_BENCHMARK_SCORE, Math.round((1000 * perSec) / REFERENCE_CHALLENGE_ITEMS_PER_SEC)));
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * The PC's score from its most recent runs: drop runs more than 2× away from
 * the median (a stalled run, a lucky one), then take the median of the rest.
 * Null until MIN_SAMPLES runs survive.
 */
export function medianScore(runs: ReadonlyArray<{ items: number; millis: number }>): number | null {
  const scores = runs.slice(0, SAMPLE_WINDOW).map((r) => runScore(r.items, r.millis));
  if (scores.length < MIN_SAMPLES) return null;
  const m = median(scores);
  const kept = scores.filter((s) => s >= m / 2 && s <= m * 2);
  return kept.length >= MIN_SAMPLES ? median(kept) : null;
}

/** Whether this lease should be a challenge instead of real work. */
export function wantsChallenge(args: {
  measured: boolean;
  lastChallengeAt: Date | null;
  now: Date;
  rand?: (max: number) => number;
}): boolean {
  const since = args.lastChallengeAt ? (args.now.getTime() - args.lastChallengeAt.getTime()) / 1000 : Infinity;
  if (!args.measured) return since >= FIRST_CHALLENGE_GAP_SEC;
  return since >= CHALLENGE_MIN_GAP_SEC && (args.rand ?? randomInt)(CHALLENGE_ONE_IN) === 0;
}
