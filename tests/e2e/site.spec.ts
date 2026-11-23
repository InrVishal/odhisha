import { expect, test } from "@playwright/test";
import { isRemote, useFreshIp, writeTestsInOneBrowserWhenRemote } from "./helpers";

test("pricing calculator shows the full breakdown, electricity included", async ({ page }) => {
  await page.goto("/pricing");
  const out = page.locator("output");
  // Defaults: RTX 4070 PC, 14 hours, ₹9/unit, ₹25/hr → ₹552 (see tests/unit/pricing.test.ts).
  await expect(out).toContainText("₹552");
  await expect(out).toContainText("Owner's electricity");
  await expect(out).toContainText("₹44.10");
  await expect(out).toContainText("Verification buffer (12%)");
  await expect(out).toContainText("₹47.30");
  await expect(out).toContainText("The owner receives ₹394.10, and ₹44.10 of that is their electricity.");
  await expect(out).toContainText("That's ₹39.42 per GPU-hour, all in.");

  await page.getByLabel("Electricity tariff (₹ per unit)").fill("12");
  await expect(out).toContainText("₹58.80"); // 0.35 kW × 14 h × ₹12

  await page.getByLabel("GPU hours").fill("abc");
  await expect(out).toContainText("Enter hours as a number");
});

test("home page says demo mode (in the footer, no top banner) and shows a computed sample quote", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("This is a working prototype")).toHaveCount(0);
  await expect(page.getByRole("contentinfo").getByText(/Demo mode: payments, UPI payouts and GPU EMI are simulated/)).toBeVisible();
  await expect(page.getByText(/Sample quote: 14 GPU-hours on RTX 4070 PCs .*₹552, done by 6:00 AM/)).toBeVisible();
});

test("pricing page shows the all-in price per GPU-hour for each PC", async ({ page }) => {
  await page.goto("/pricing");
  const table = page.getByRole("table").filter({ hasText: "All-in per GPU-hour" });
  await expect(table.getByRole("row", { name: /RTX 3060 PC/ })).toContainText("₹39.04");
  await expect(table.getByRole("row", { name: /RTX 4070 PC/ })).toContainText("₹39.42");
  await expect(table.getByRole("row", { name: /RTX 4090 PC/ })).toContainText("₹42.57");
  await expect(page.getByText("14 GPU-hours on an RTX 4070 PC comes to ₹552")).toBeVisible();
});

test("waitlist gives the same answer for a repeat signup", async ({ page }) => {
  writeTestsInOneBrowserWhenRemote();
  await useFreshIp(page);
  const email = `repeat-${Date.now()}@example.in`;
  for (let i = 0; i < 2; i++) {
    await page.goto("/waitlist?as=buyer");
    await expect(page.getByRole("radio", { name: "Run AI jobs" })).toBeChecked();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(page.getByRole("status")).toContainText("If that email wasn't already on the list, it is now.");
  }
});

test("waitlist explains each missing field", async ({ page }) => {
  await useFreshIp(page);
  await page.goto("/waitlist");
  await page.getByLabel("Email", { exact: true }).fill("not-an-email");
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByText("That email address doesn't look right.")).toBeVisible();
  await expect(page.getByText("Tick the box so we're allowed to email you.")).toBeVisible();
});

test("server HTML carries a nonce CSP and no inline style attributes", async ({ request }) => {
  // Style attributes in server HTML would be blocked by the CSP. (Styles React
  // sets from JS after load are allowed, so the live DOM isn't checked.)
  for (const path of ["/", "/pricing", "/waitlist", "/faq"]) {
    const res = await request.get(path);
    expect(res.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
    expect(await res.text(), path).not.toMatch(/\sstyle="/);
  }
});

test("robots.txt and sitemap.xml are valid and list the public pages", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toMatch(/^text\/plain/);
  const txt = await robots.text();
  expect(txt).toMatch(/^User-Agent: \*$/m);
  expect(txt).toMatch(/^Allow: \/pricing$/m);
  expect(txt).toMatch(/^Disallow: \/api\/$/m);
  expect(txt).toMatch(/^Disallow: \/dashboard$/m);
  expect(txt).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
  // Every non-empty line is a known directive (what Lighthouse's robots-txt audit checks).
  for (const line of txt.split("\n").filter((l) => l.trim())) expect(line).toMatch(/^(User-Agent|Allow|Disallow|Sitemap|Host): \S/);

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain("<urlset");
  for (const path of ["/pricing", "/time-bank", "/faq"]) expect(xml).toContain(`${path}</loc>`);
});

test("no console errors (including CSP violations) on any public page", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const path of ["/", "/how-it-works", "/owners", "/builders", "/pricing", "/time-bank", "/faq", "/waitlist", "/privacy", "/terms"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(errors).toEqual([]);
});

test("waitlist signups are rate limited per IP (5 an hour)", async ({ page }) => {
  test.skip(isRemote, "needs a spoofable client IP, which only the local server allows");
  await useFreshIp(page);
  for (let i = 0; i < 6; i++) {
    await page.goto("/waitlist");
    await page.getByLabel("Email", { exact: true }).fill(`limit-${i}-${Date.now()}@example.in`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Join the waitlist" }).click();
    if (i < 5) await expect(page.getByRole("status")).toBeVisible();
  }
  await expect(page.getByText("Too many tries from your network")).toBeVisible();
});
