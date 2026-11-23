#!/usr/bin/env node
/**
 * Scans everything a browser can download (client JavaScript, CSS, HTML and
 * RSC payloads of the build) for secrets. Fails (exit 1) on:
 *
 * 1. the VALUE of any secret-looking environment variable in this process
 *    (and in --env-file files, e.g. what `vercel pull` wrote), so a secret
 *    inlined into the bundle is caught even if it looks random;
 * 2. secret-looking patterns (private keys, database URLs with passwords,
 *    provider key prefixes);
 * 3. the NAME of a server-only variable in client JavaScript (server code
 *    that leaked into the browser bundle);
 * 4. any source map (.map file or sourceMappingURL comment) served publicly.
 *
 * Never prints a secret: only the variable name or pattern name and the file.
 *
 *   node scripts/scan-bundle.mjs [--env-file .vercel/.env.preview.local] [dir ...]
 *   (default dirs: .next/static .next/server/app .vercel/output/static, those that exist)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Same rule as lib/env.ts: names that must never reach the browser. */
export const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|_KEY$|^KEY_|DSN|DATABASE|ADMIN)/i;

/** Server-only names that have no business in client JavaScript. */
export const SERVER_ONLY_NAMES = [
  "DATABASE_URL",
  "DATABASE_URL_READONLY",
  "AUTH_SECRET",
  "CRON_SECRET",
  "COORDINATOR_SIGNING_KEY",
  "DATA_ENCRYPTION_KEY",
  "AUTH_RESEND_KEY",
  "AUTH_GOOGLE_SECRET",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_TOKEN",
  "ADMIN_EMAILS",
  "ADMIN_ALERT_EMAIL",
];

export const PATTERNS = [
  ["private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["database URL with a password", /postgres(?:ql)?:\/\/[^:/\s"'`]+:[^@\s"'`]+@/],
  ["Neon password", /\bnpg_[A-Za-z0-9]{12,}/],
  ["Resend API key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["Stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["Vercel bypass header with a value", /x-vercel-protection-bypass["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}/i],
];

const TEXT = /\.(js|mjs|cjs|css|html|rsc|json|txt|map|body)$/;
/**
 * Under a server output folder only prerendered pages reach the browser (the
 * HTML and RSC payloads); the server's own .js and .map files never do.
 */
const SERVED_FROM_SERVER = /\.(html|rsc|body)$/;
const isServerDir = (file) => file.split(/[\\/]/).includes("server");
/** Values this short or this common can't be told apart from ordinary text. */
const MIN_VALUE_LENGTH = 12;
const IGNORE_VALUES = new Set(["true", "false", "production", "preview", "development"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** KEY=value lines (quotes stripped), as written by `vercel pull` / dotenv. */
export function readEnvFile(file) {
  const vars = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    vars[m[1]] = v;
  }
  return vars;
}

/** The secret values to look for: secret-looking names, minus public ones and short or common values. */
export function secretValues(env) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || name.startsWith("NEXT_PUBLIC_") || !SECRET_NAME.test(name)) continue;
    if (value.length < MIN_VALUE_LENGTH || IGNORE_VALUES.has(value)) continue;
    out.push([name, value]);
    // Also catch the value as JSON or URL encoded inside a string.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) out.push([name, escaped]);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out.push([name, encoded]);
  }
  return out;
}

/** Returns findings as { file, what } (what never contains a secret). */
export function scan(dirs, env) {
  const values = secretValues(env);
  const findings = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      if (isServerDir(file) && !SERVED_FROM_SERVER.test(file)) continue;
      if (file.endsWith(".map")) {
        findings.push({ file, what: "public source map file" });
        continue;
      }
      if (!TEXT.test(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const [name, value] of values) if (text.includes(value)) findings.push({ file, what: `value of ${name}` });
      for (const [name, re] of PATTERNS) if (re.test(text)) findings.push({ file, what: name });
      if (/\.(js|mjs|cjs)$/.test(file)) {
        if (/[#@]\s*sourceMappingURL=(?!data:)/.test(text)) findings.push({ file, what: "sourceMappingURL comment" });
        const isClient = file.split(path.sep).includes("static");
        if (isClient) for (const n of SERVER_ONLY_NAMES) if (new RegExp(`\\b${n}\\b`).test(text)) findings.push({ file, what: `server-only name ${n} in client JavaScript` });
      }
    }
  }
  // One line per file and finding.
  return [...new Map(findings.map((f) => [`${f.file}|${f.what}`, f])).values()];
}

function main(argv) {
  const files = [];
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") files.push(argv[++i]);
    else dirs.push(argv[i]);
  }
  const roots = dirs.length ? dirs : [".next/static", ".next/server/app", ".vercel/output/static"];
  const env = { ...process.env };
  for (const f of files) if (f && existsSync(f)) Object.assign(env, readEnvFile(f));
  const present = roots.filter((d) => existsSync(d));
  if (present.length === 0) {
    console.error("scan-bundle: nothing to scan (build first)");
    process.exit(2);
  }
  let count = 0;
  for (const d of present) count += walk(d).length;
  const findings = scan(present, env);
  const checked = secretValues(env).length;
  if (findings.length) {
    for (const f of findings) console.error(`LEAK  ${f.what}  in ${f.file}`);
    console.error(`scan-bundle: ${findings.length} finding(s) in ${count} files`);
    process.exit(1);
  }
  console.log(`scan-bundle: ${count} files in ${present.join(", ")}: no secrets, secret-looking strings, server-only names or source maps (checked ${checked} secret values and ${PATTERNS.length} patterns)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
