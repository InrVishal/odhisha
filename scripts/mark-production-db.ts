/**
 * Marks the production database as production's: writes its Neon endpoint id
 * to deployment_marker (lib/isolation.ts). Run by CI's production job right
 * after migrating, as the owner role; nothing else writes the table.
 *
 *   DATABASE_URL=<production, owner, direct> npx tsx scripts/mark-production-db.ts
 *
 * Preview branches copied from production carry this id while having their
 * own endpoint; a preview that finds its own endpoint here is on production's
 * database and refuses to run. Prints the endpoint id (not secret), never the URL.
 */
import { sql } from "drizzle-orm";
import { createDb } from "../lib/db/client";
import { neonEndpointId, PRODUCTION_ENDPOINT_MARKER } from "../lib/isolation";

async function main() {
  const url = process.env.DATABASE_URL;
  const endpoint = neonEndpointId(url);
  if (!url || !endpoint) {
    console.error("mark-production-db: DATABASE_URL must be the production Neon database (an ep-... host)");
    process.exit(2);
  }
  const handle = await createDb(url);
  try {
    await handle.db.execute(
      sql`insert into deployment_marker (name, value, updated_at) values (${PRODUCTION_ENDPOINT_MARKER}, ${endpoint}, now())
          on conflict (name) do update set value = excluded.value, updated_at = now()`,
    );
    console.log(`mark-production-db: production endpoint is ${endpoint}`);
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error("mark-production-db failed:", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, "<url>") : "unknown error");
  process.exit(1);
});
