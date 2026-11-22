import { test, type Page } from "@playwright/test";

export const isRemote = Boolean(process.env.E2E_BASE_URL);

let counter = 0;

/**
 * Gives this page its own client IP so per-IP rate limits don't collide
 * across tests. Works against the local server (which trusts x-real-ip).
 * On Vercel the platform overwrites x-real-ip, so it has no effect there.
 */
export async function useFreshIp(page: Page): Promise<string> {
  counter += 1;
  const ip = `198.18.${(process.pid % 250) + 1}.${(counter % 250) + 1}`;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  await page.setExtraHTTPHeaders({ "x-real-ip": ip, ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) });
  return ip;
}

/**
 * Tests that write rate-limited data (waitlist signups) run in ONE project
 * only against a deployed preview, where every request comes from the same
 * CI runner IP and the real per-IP limit applies.
 *
 * Checks the project name, not the browser engine: the "mobile" project
 * (Pixel 7) is Chromium too, so an engine check would let it write as well.
 */
export const REMOTE_WRITE_PROJECT = "chromium";

export function writeTestsInOneBrowserWhenRemote(): void {
  test.skip(isRemote && test.info().project.name !== REMOTE_WRITE_PROJECT, "rate-limited writes run once against a deployed preview");
}
