import { defineConfig } from "drizzle-kit";

// `generate` only reads the schema; it needs no database. `migrate` is done by
// scripts/migrate.ts so it uses the same driver as the app.
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
