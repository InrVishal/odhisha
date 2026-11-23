import { randomInt } from "node:crypto";
import { MAX_BENCHMARK_SCORE } from "@/lib/timebank";
import { cosine } from "./verify";

/**
 * Coordinator challenges: signed text-embedding pieces the coordinator makes
 * up itself, to catch cheating PCs (a canary) and to time them (the
 * benchmark), without trusting anything the PC says about itself.
 *
 * The sentences are made up fresh each time from realistic templates, so
 * nobody can look the answers up ahead of time. What makes it a canary is the
 * structure hidden inside, which only a real run of the model produces:
 * - exact duplicates must give the same vector;
 * - a copy with its first letter's case flipped must give the same vector
 *   (the model is uncased);
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

/** A full text-embedding piece (maxItemsPerFragment), the size most real pieces have. */
export const CHALLENGE_ITEMS = 250;
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

/**
 * Sentences that read like what buyers send: support tickets, reviews,
 * notes, searches and product listings, filled in from small word lists.
 * The templates are public (this file), so a cheater who reads the code can
 * still recognise them; that's why a re-run of a verified real piece
 * (canary.ts) is used instead whenever one is available.
 */
const SLOTS: Record<string, readonly string[]> = {
  item: ["phone", "charger", "laptop bag", "mixer grinder", "water bottle", "kurta", "pair of headphones", "router", "pressure cooker", "school bag"],
  problem: ["damaged", "two days late", "with a part missing", "in the wrong size", "without the bill", "with a cracked lid"],
  fix: ["refund", "replacement", "return pickup", "copy of the invoice"],
  status: ["packed", "shipped", "out for delivery", "pending", "on hold"],
  app: ["banking", "food delivery", "train booking", "college portal", "cab", "grocery"],
  screen: ["the orders page", "my profile", "the payment screen", "notifications", "the wallet"],
  plan: ["mobile", "broadband", "streaming", "gym", "cloud storage"],
  product: ["earbuds", "smartwatch", "ceiling fan", "gas stove", "power bank", "keyboard", "air cooler", "rice cooker", "table lamp"],
  part: ["strap", "lid", "cable", "remote", "switch", "handle", "charging port"],
  adj: ["cheap", "loose", "flimsy", "heavy", "a bit stiff", "solid"],
  usage: ["daily calls", "gaming", "music on the bus", "online classes", "long video calls"],
  verdict: ["fine", "decent", "not great", "better than I expected", "about average"],
  price: ["₹1,000", "₹2,500", "₹5,000", "₹15,000", "₹800"],
  team: ["design", "sales", "hostel committee", "placement", "finance", "support"],
  day: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  time: ["10 AM", "2:30 PM", "4 PM", "6 PM", "9:15 AM"],
  doc: ["fee receipt", "project report", "leave form", "ID proof", "bonafide certificate"],
  office: ["accounts office", "department office", "warden", "exam cell"],
  course: ["physics", "chemistry", "computer", "electronics", "biology"],
  bill: ["electricity", "water", "internet", "phone", "maintenance"],
  train: ["Rajdhani", "Shatabdi", "Duronto", "Vande Bharat", "Intercity", "Jan Shatabdi"],
  city: ["Bhubaneswar", "Cuttack", "Puri", "Kolkata", "Hyderabad", "Chennai", "Pune", "Delhi", "Rourkela"],
  brand: ["Nova", "Orbit", "Kiran", "Sitara", "Vayu", "Prakash"],
  feature: ["fast charging", "Bluetooth 5.3", "a steel body", "a 2 year warranty", "a timer", "low noise"],
  color: ["black", "blue", "white", "grey", "green"],
  size: ["small", "medium", "large", "1.5 L", "20 cm"],
  num: ["4471", "10293", "88812", "5530", "71204", "3398"],
  n: ["2", "3", "4", "5", "6", "10"],
};

/** Templates by kind. A "far" sentence is always of a different kind than its "near" pair. */
const TEMPLATES: readonly (readonly string[])[] = [
  [
    "My {item} arrived {problem}, can I get a {fix}?",
    "Order {num} still shows {status} after {n} days.",
    "The {app} app logs me out every time I open {screen}.",
    "I was charged twice for my {plan} plan this month.",
    "How do I change the delivery address for order {num}?",
    "Still waiting for the {fix} on my {item}.",
  ],
  [
    "The {product} works well but the {part} feels {adj}.",
    "Battery lasts about {n} hours with {usage}, which is {verdict}.",
    "Good value for {price}, though delivery took {n} days.",
    "{n} stars, the {part} stopped working after {n} weeks.",
    "Bought this {product} for {usage} and it is {verdict}.",
  ],
  [
    "Meeting with the {team} team moved to {day} at {time}.",
    "Submit the {doc} to the {office} before {day}.",
    "The {course} lab is closed on {day} for maintenance.",
    "Reminder: pay the {bill} bill by {day}.",
    "Bring your {doc} for the {team} interview on {day}.",
  ],
  [
    "best {product} under {price} for {usage}",
    "is the {train} to {city} running late today",
    "how to reset {app} app password",
    "{city} weather {day} evening",
    "{train} timings from {city}",
  ],
  [
    "{brand} {product} with {feature}, {color}, {size}",
    "{brand} {product}, {color}, pack of {n}",
    "{color} {product} by {brand} with {feature}",
  ],
];

const NEAR_TAILS = ["Please help.", "Thanks.", "Any update?", "This is urgent.", "Again today."];

function fill(rand: (max: number) => number, template: string): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const xs = SLOTS[k]!;
    return xs[rand(xs.length)]!;
  });
}

function sentence(rand: (max: number) => number, kind = rand(TEMPLATES.length)): string {
  const ts = TEMPLATES[kind]!;
  return fill(rand, ts[rand(ts.length)]!);
}

/** "Order 4471 ..." → "order 4471 ..."; "is the ..." → "Is the ...". The model is uncased: same vector. */
function flipFirst(t: string): string {
  const c = t.charAt(0);
  return (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + t.slice(1);
}

/** A sentence that starts with a letter, so flipping its case changes it. */
function letterSentence(rand: (max: number) => number): string {
  for (;;) {
    const s = sentence(rand);
    if (/^[A-Za-z]/.test(s)) return s;
  }
}

export interface ChallengeSpec {
  v: 1;
  items: number;
  duplicates: Array<[number, number]>;
  casePairs: Array<[number, number]>;
  /** [sentence, near (sentence + a few words), far (unrelated)] */
  triples: Array<[number, number, number]>;
}

/** Makes one challenge: the texts to send and the hidden structure to check. */
export function buildChallenge(rand: (max: number) => number = randomInt): { texts: string[]; spec: ChallengeSpec } {
  const texts: string[] = [];
  const duplicates: ChallengeSpec["duplicates"] = [];
  const casePairs: ChallengeSpec["casePairs"] = [];
  const triples: ChallengeSpec["triples"] = [];
  const push = (t: string) => texts.push(t) - 1;
  for (let i = 0; i < DUPLICATE_PAIRS; i++) {
    const s = sentence(rand);
    duplicates.push([push(s), push(s)]);
  }
  for (let i = 0; i < CASE_PAIRS; i++) {
    const s = letterSentence(rand);
    casePairs.push([push(s), push(flipFirst(s))]);
  }
  for (let i = 0; i < TRIPLES; i++) {
    const kind = rand(TEMPLATES.length);
    const s = sentence(rand, kind);
    const other = (kind + 1 + rand(TEMPLATES.length - 1)) % TEMPLATES.length;
    triples.push([push(s), push(`${s} ${NEAR_TAILS[rand(NEAR_TAILS.length)]}`), push(sentence(rand, other))]);
  }
  while (texts.length < CHALLENGE_ITEMS) push(sentence(rand));

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
