import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = {
  "@": path.resolve(import.meta.dirname),
  // `server-only` throws outside React Server Components. Tests are server code.
  "server-only": path.resolve(import.meta.dirname, "tests/helpers/server-only-stub.ts"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // Each file gets its own database; files may run in parallel.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      // Thin wrappers around Next.js/Auth.js runtime that only E2E can exercise.
      exclude: ["lib/auth/index.ts", "lib/db/index.ts", "lib/auth/guards.ts", "lib/db/schema.ts"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
      reporter: ["text", "json-summary", "html"],
    },
  },
});
