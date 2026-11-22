/**
 * Runs once when a server instance boots. Validating the environment here
 * means a misconfigured deploy fails on its first request with a clear list
 * of the bad variable names (never their values).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("./lib/env");
    getEnv();
  }
}
