// Points git at .githooks/ so the gitleaks pre-commit hook runs for everyone.
// Runs from `npm install` (the "prepare" script). Skipped outside a git repo
// and in CI, where gitleaks runs as its own pipeline step.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (process.env.CI || !existsSync(".git")) process.exit(0);
try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // git missing: nothing to install.
}
