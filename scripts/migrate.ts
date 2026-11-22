/**
 * Applies pending migrations. Run as a deploy step (see DEPLOY.md), and by
 * `npm run db:migrate` locally.
 *
 * Uses DATABASE_URL_UNPOOLED when set (Neon recommends a direct connection
 * for migrations), otherwise DATABASE_URL.
 */
import { config } from "dotenv";
import { createDb, migrateDb } from "../lib/db/client";

// Real environment variables (CI) win; then .env.local, then .env.
config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const handle = await createDb(url);
  try {
    await migrateDb(handle);
    console.log(`migrations applied (${handle.driver})`);
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  // Print the message only: a connection error can include the URL.
  console.error("migration failed:", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, "<url>") : "unknown error");
  process.exit(1);
});
