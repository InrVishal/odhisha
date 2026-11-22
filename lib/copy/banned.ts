/**
 * Banned words and phrases from the brief (§4), as case-insensitive
 * patterns that also catch common inflections ("leveraging", "unlocks").
 */

const APOS = "['’]";

export const BANNED: ReadonlyArray<{ label: string; re: RegExp }> = [
  ["seamless / seamlessly", /\bseamless(ly)?\b/],
  ["leverage", /\bleverag(e|es|ed|ing)\b/],
  ["unlock", /\bunlock(s|ed|ing)?\b/],
  ["empower", /\bempower(s|ed|ing|ment)?\b/],
  ["revolutionize", /\brevolutioni[sz](e|es|ed|ing)\b/],
  ["cutting-edge", /\bcutting[-\s]edge\b/],
  ["state-of-the-art", /\bstate[-\s]of[-\s]the[-\s]art\b/],
  ["robust", /\brobust(ly|ness)?\b/],
  ["game-changer", /\bgame[-\s]?chang(er|ers|ing)\b/],
  ["harness", /\bharness(es|ed|ing)?\b/],
  ["elevate", /\belevat(e|es|ed|ing)\b/],
  ["delve", /\bdelv(e|es|ed|ing)\b/],
  ["supercharge", /\bsupercharg(e|es|ed|ing)\b/],
  ["unleash", /\bunleash(es|ed|ing)?\b/],
  ["next-gen", /\bnext[-\s]?gen(eration)?\b/],
  ["effortless", /\beffortless(ly)?\b/],
  ["transformative", /\btransformative\b/],
  ["synergy", /\bsynerg(y|ies|istic)\b/],
  ["holistic", /\bholistic(ally)?\b/],
  ["in today's fast-paced world", new RegExp(`\\bin today${APOS}s fast[-\\s]paced world\\b`)],
  ["whether you're X or Y", new RegExp(`\\bwhether you${APOS}re\\b.{1,60}?\\bor\\b`)],
  ["not just X, it's Y", new RegExp(`\\bnot just\\b.{1,60}?,\\s*it${APOS}s\\b`)],
  ["say goodbye to", /\bsay goodbye to\b/],
  ["look no further", /\blook no further\b/],
  ["the future of", /\bthe future of\b/],
  ["at the intersection of", /\bat the intersection of\b/],
].map(([label, re]) => ({ label: label as string, re: new RegExp((re as RegExp).source, "iu") }));

export interface CopyFinding {
  rule: string;
  match: string;
  where: string;
}

export function findBanned(text: string, where: string): CopyFinding[] {
  const out: CopyFinding[] = [];
  for (const { label, re } of BANNED) {
    const m = re.exec(text);
    if (m) out.push({ rule: label, match: m[0], where });
  }
  return out;
}

const EMOJI = /\p{Extended_Pictographic}/u;

/** "No emoji in headings": checks <h1>–<h6> text in rendered HTML. */
export function findEmojiInHeadings(html: string, where: string): CopyFinding[] {
  const out: CopyFinding[] = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = htmlToText(m[2]!);
    if (EMOJI.test(text)) out.push({ rule: "no emoji in headings", match: text, where });
  }
  return out;
}

/** "Em dashes very rarely": at most this many per page. */
export const MAX_EM_DASHES_PER_PAGE = 2;

export function countEmDashes(text: string): number {
  return (text.match(/—/g) ?? []).length;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&nbsp;": " ",
  "&#x27;": "'",
  "&#39;": "'",
  "&apos;": "'",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

/**
 * Visible text of an HTML page, for the copy check (our own built pages, not
 * user input; this is not a sanitizer). Drops script/style/template blocks
 * and tags, then decodes a few entities.
 *
 * - Closing tags may carry whitespace or junk (`</script >`, `</SCRIPT x>`),
 *   which browsers accept, so the patterns allow it.
 * - Entities are decoded in ONE pass, so `&amp;lt;` becomes `&lt;` (literal
 *   text), not `<`. Decoding `&amp;` first would unescape twice.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#x27|#39|apos|quot|lt|gt|amp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

/** Every string inside a nested content object, with its path. */
export function collectStrings(value: unknown, path = ""): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectStrings(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => collectStrings(v, path ? `${path}.${k}` : k));
  }
  return [];
}
