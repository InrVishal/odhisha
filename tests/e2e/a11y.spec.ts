import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { allPages } from "../../content/site";
import { useFreshIp, writeTestsInOneBrowserWhenRemote } from "./helpers";

/** Every public page, plus the login pages. */
const PAGES = [...allPages.map((p) => p.path), "/signin", "/signin/check-email", "/signin/error"];

test.describe("accessibility (axe-core)", () => {
  for (const path of PAGES) {
    test(`${path} has no serious or critical issues`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")})`)).toEqual([]);
    });
  }
});

test.describe("keyboard only", () => {
  test("first Tab reaches the skip link, which jumps to the main content", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "WebKit skips links on Tab unless the OS setting is on");
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  test("every page has exactly one h1 and a main landmark", async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator("h1"), path).toHaveCount(1);
      await expect(page.locator("main#main"), path).toHaveCount(1);
    }
  });

  test("the pricing calculator works with the keyboard alone", async ({ page }) => {
    await page.goto("/pricing");
    const hours = page.getByLabel("GPU hours");
    await hours.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("20");
    await expect(page.locator("output")).toContainText("₹789");
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByLabel("GPU class")).toBeFocused();
    await page.keyboard.press("ArrowDown"); // RTX 4070 → RTX 4090
    // 20 h on a 0.60 kW PC: ₹108 power + ₹500 owner pay → +12% → +25% → ₹852
    await expect(page.locator("output")).toContainText("₹852");
    await expect(page.getByLabel("Owner's rate (₹ per hour)")).toHaveValue("25");
  });

  test("the waitlist form can be filled and sent with the keyboard", async ({ page, browserName }) => {
    writeTestsInOneBrowserWhenRemote(browserName);
    await useFreshIp(page);
    await page.goto("/waitlist");
    await page.getByLabel("Email", { exact: true }).focus();
    await page.keyboard.type(`kb-${Date.now()}@example.in`);
    await page.getByRole("radio", { name: "Earn with my GPU" }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Join the waitlist" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("We'll write when there's a spot for you.");
  });
});

test.describe("mobile menu", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opens with the keyboard and links to every section", async ({ page }) => {
    await page.goto("/");
    const menu = page.locator("summary", { hasText: "Menu" });
    await menu.focus();
    await page.keyboard.press("Enter");
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const name of ["How it works", "For GPU owners", "For AI builders", "Pricing", "Time-Bank", "FAQ"]) {
      await expect(nav.getByRole("link", { name })).toBeVisible();
    }
  });

  test("no horizontal scrolling on a phone", async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
