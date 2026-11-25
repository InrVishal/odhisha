import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ES module script, no type declarations.
import { readEnvFile, scan, secretValues } from "../../scripts/scan-bundle.mjs";

type Finding = { file: string; what: string };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bundle(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "ns-scan-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}
const whats = (f: Finding[]) => f.map((x) => x.what).sort();

describe("D1: the client bundle scan", () => {
  const env = { AUTH_SECRET: "s3cr3t-value-that-is-long-enough", CRON_SECRET: "another-long-secret-value-0001", NEXT_PUBLIC_SITE: "https://x.example", DEMO_MODE: "true" };

  it("passes a clean bundle", () => {
    const root = bundle({ "static/chunks/app.js": "console.log('hello NightShift')", "server/app/index.html": "<h1>NightShift</h1>" });
    expect(scan([root], env)).toEqual([]);
  });

  it("finds a secret's value, even JSON- or URL-encoded, without printing it", () => {
    const root = bundle({
      "static/chunks/a.js": `const k = "${env.AUTH_SECRET}";`,
      "server/app/b.html": `<script>self.x=${JSON.stringify(encodeURIComponent("p@ss/word with spaces 1234"))}</script>`,
    });
    const f = scan([root], { ...env, DB_PASSWORD: "p@ss/word with spaces 1234" }) as Finding[];
    expect(whats(f)).toEqual(["value of AUTH_SECRET", "value of DB_PASSWORD"]);
    expect(JSON.stringify(f)).not.toContain(env.AUTH_SECRET);
  });

  it.each([
    ["private key", "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI"],
    ["database URL with a password", "postgresql://neondb_owner:abc123@ep-x.neon.tech/neondb"],
    ["Neon password", "npg_AbCdEfGhIjKlMn"],
    ["Resend API key", "re_AbCdEfGh_IjKlMnOpQr"],
    ["Google OAuth client secret", "GOCSPX-abcdefghijklmnopqrstuv"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ])("finds a %s pattern", (what, text) => {
    const root = bundle({ "static/chunks/x.js": `var s = ${JSON.stringify(text)};` });
    expect(whats(scan([root], {}))).toContain(what);
  });

  it("finds server-only names in client JavaScript (server code in the browser bundle)", () => {
    const root = bundle({ "static/chunks/x.js": "process.env.DATABASE_URL", "server/app/page.js": "process.env.DATABASE_URL" });
    const f = scan([root], {}) as Finding[];
    expect(f.map((x) => [path.basename(path.dirname(x.file)), x.what])).toEqual([["chunks", "server-only name DATABASE_URL in client JavaScript"]]);
  });

  it("in server output, only what a browser can fetch (prerendered HTML and RSC) counts", () => {
    const root = bundle({
      "server/app/page.js": 'const k = "-----BEGIN PRIVATE KEY-----"',
      "server/app/page.js.map": "{}",
      "server/app/index.html": "<p>-----BEGIN PRIVATE KEY-----</p>",
      "server/app/index.rsc": "postgres://u:pw@host/db",
    });
    expect((scan([root], {}) as Finding[]).map((x) => [path.basename(x.file), x.what]).sort()).toEqual([
      ["index.html", "private key"],
      ["index.rsc", "database URL with a password"],
    ]);
  });

  it("finds public source maps", () => {
    const root = bundle({ "static/chunks/x.js": "a()\n//# sourceMappingURL=x.js.map", "static/chunks/x.js.map": "{}" });
    expect(whats(scan([root], {}))).toEqual(["public source map file", "sourceMappingURL comment"]);
  });

  it("only checks secret-looking names, and skips short or common values", () => {
    const names = (secretValues({ AUTH_SECRET: "long-enough-secret!", SITE_URL: "https://long-but-public.example", X_TOKEN: "short", NEXT_PUBLIC_KEY: "long-but-public-on-purpose" }) as Array<[string, string]>).map(([n]) => n);
    expect([...new Set(names)]).toEqual(["AUTH_SECRET"]);
  });

  it("reads vercel pull's env file", () => {
    const root = bundle({ ".env.preview.local": 'AUTH_SECRET="from-vercel-pull-1234567"\n# comment\nPLAIN=x\n' });
    expect(readEnvFile(path.join(root, ".env.preview.local"))).toEqual({ AUTH_SECRET: "from-vercel-pull-1234567", PLAIN: "x" });
  });
});
