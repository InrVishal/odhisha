#!/usr/bin/env node
/**
 * CI only, on a PREVIEW Neon branch: gives the app_runtime and readonly
 * roles (created NOLOGIN by migration 0008) a fresh random login password
 * for this run, and hands their connection URLs to later steps through
 * $GITHUB_ENV, masked in the log. The preview is then deployed with these,
 * so it runs exactly as production should: as app_runtime, never as the owner.
 *
 * Env: OWNER_URL (unpooled, owner), POOLED_URL (owner, pooled host), GITHUB_ENV.
 * Never prints a password or URL.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import pg from "pg";

const { OWNER_URL, POOLED_URL, GITHUB_ENV } = process.env;
if (!OWNER_URL || !POOLED_URL || !GITHUB_ENV) {
  console.error("OWNER_URL, POOLED_URL and GITHUB_ENV are required");
  process.exit(2);
}
if (!/\.neon\.tech/.test(new URL(OWNER_URL).hostname)) {
  console.error("preview-db-roles only runs against a Neon preview branch");
  process.exit(2);
}

const withUser = (url, user, password) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

const client = new pg.Client({ connectionString: OWNER_URL });
await client.connect();
const env = [];
try {
  for (const [role, name] of [
    ["app_runtime", "RUNTIME"],
    ["readonly", "READONLY"],
  ]) {
    // Hex only, so it can't break out of the quoted literal below.
    const password = randomBytes(24).toString("hex");
    console.log(`::add-mask::${password}`);
    await client.query(`alter role ${role} with login password '${password}'`);
    const direct = withUser(OWNER_URL, role, password);
    const pooled = withUser(POOLED_URL, role, password);
    console.log(`::add-mask::${direct}`);
    console.log(`::add-mask::${pooled}`);
    env.push(`${name}_DATABASE_URL=${direct}`, `${name}_DATABASE_URL_POOLED=${pooled}`);
  }
} finally {
  await client.end();
}
appendFileSync(GITHUB_ENV, env.join("\n") + "\n");
console.log("preview-db-roles: app_runtime and readonly can log in for this run (passwords masked, never stored)");
