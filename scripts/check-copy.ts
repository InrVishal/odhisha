/**
 * Copy check (brief §4 and §6.9). Fails CI when:
 *   1. COPY.md is out of date with content/site.ts
 *   2. any banned word or phrase appears in the site copy source
 *   3. any banned word, emoji-in-heading or too many em dashes appear on a
 *      page of the BUILT site (starts `next start` and crawls every page)
 *
 *   npm run copy:check            # all three (needs `npm run build` first)
 *   npm run copy:check -- --source-only
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyValues } from "../content/derived";
import * as content from "../content/site";
import {
  collectStrings,
  countEmDashes,
  findBanned,
  findEmojiInHeadings,
  htmlToText,
  MAX_EM_DASHES_PER_PAGE,
  type CopyFinding,
} from "../lib/copy/banned";
import { renderCopyMd } from "./copy-md";

const findings: CopyFinding[] = [];
const problems: string[] = [];

// 1. COPY.md in sync
let committed = "";
try {
  committed = readFileSync("COPY.md", "utf8").replace(/\r\n/g, "\n");
} catch {
  problems.push("COPY.md is missing. Run: npm run copy:export");
}
if (committed && committed !== renderCopyMd()) {
  problems.push("COPY.md is out of date with content/site.ts. Run: npm run copy:export");
}

// 2. Source strings (content + computed values) and COPY.md itself
for (const { path, text } of [...collectStrings(content), ...collectStrings(copyValues, "derived")]) {
  findings.push(...findBanned(text, `content/site.ts ${path}`));
}
for (const [i, line] of committed.split("\n").entries()) findings.push(...findBanned(line, `COPY.md:${i + 1}`));

// 3. Built site
async function crawl(): Promise<void> {
  const port = 3199;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Loopback only: this is the `next start` process spawned just above, which
  // serves plain HTTP. Nothing leaves the machine, so TLS is not applicable.
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback to our own spawned server (see above)
        up = (await fetch(`${base}/api/health`)).status < 600;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!up) throw new Error("built site did not start; run `npm run build` first");

    const paths = [...content.allPages.map((p) => p.path), "/signin", "/signin/check-email", "/signin/error", "/this-page-does-not-exist"];
    for (const path of paths) {
      const res = await fetch(base + path);
      const html = await res.text();
      if (!res.ok && path !== "/this-page-does-not-exist") problems.push(`${path}: HTTP ${res.status}`);
      const text = htmlToText(html);
      findings.push(...findBanned(text, `built ${path}`));
      findings.push(...findEmojiInHeadings(html, `built ${path}`));
      const dashes = countEmDashes(text);
      if (dashes > MAX_EM_DASHES_PER_PAGE) problems.push(`${path}: ${dashes} em dashes (max ${MAX_EM_DASHES_PER_PAGE})`);
      console.log(`checked ${path} (${text.length} chars)`);
    }
  } finally {
    server.kill();
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--source-only")) await crawl();
  for (const f of findings) problems.push(`${f.where}: "${f.match}" (banned: ${f.rule})`);
  if (problems.length > 0) {
    console.error(`\nCopy check FAILED (${problems.length}):\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("\nCopy check passed: COPY.md is current and no banned words, heading emoji or extra em dashes were found.");
}

main().catch((e: unknown) => {
  console.error("Copy check could not run:", e instanceof Error ? e.message : e);
  process.exit(1);
});
