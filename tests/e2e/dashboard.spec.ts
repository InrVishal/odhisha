import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Dashboards.
 *
 * - Signed out (every run): every dashboard page sends you to the login page,
 *   and the header links to it.
 * - Signed in (CI preview job only): E2E_AUTH_FILE holds sessions the live
 *   agent test created in the preview database, for an owner whose CPU node
 *   finished a real job, the buyer of that job, and an admin.
 */

const DASHBOARD_PAGES = ["/dashboard", "/dashboard/jobs", "/dashboard/jobs/new", "/dashboard/pcs", "/dashboard/earnings", "/dashboard/account", "/dashboard/admin"];

test.describe("signed out", () => {
  for (const path of DASHBOARD_PAGES) {
    test(`${path} redirects to the login page`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/signin$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Log in to NightShift");
    });
  }

  test("the header has a Log in link", async ({ page, isMobile }) => {
    await page.goto("/");
    if (isMobile) await page.getByText("Menu").click();
    await page.getByRole("link", { name: "Log in" }).first().click();
    await expect(page).toHaveURL(/\/signin$/);
  });

  test("the invoice download needs a session", async ({ request }) => {
    const res = await request.get("/api/jobs/00000000-0000-4000-8000-000000000000/invoice");
    expect(res.status()).toBe(401);
  });
});

interface Auth {
  owner: string;
  buyer: string;
  admin: string;
  jobId: string;
  nodeId: string;
}

const authFile = process.env.E2E_AUTH_FILE;
const auth: Auth | null = authFile ? (JSON.parse(readFileSync(authFile, "utf8")) as Auth) : null;

async function signIn(context: BrowserContext, baseURL: string | undefined, token: string): Promise<void> {
  const url = new URL(baseURL!);
  // Auth.js uses the __Secure- cookie on HTTPS (previews) and a plain one on a local HTTP server.
  const https = url.protocol === "https:";
  await context.addCookies([
    { name: `${https ? "__Secure-" : ""}authjs.session-token`, value: token, domain: url.hostname, path: "/", secure: https, httpOnly: true, sameSite: "Lax" },
  ]);
}

async function noSeriousA11yIssues(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")})`)).toEqual([]);
}

test.describe("signed in (preview)", () => {
  test.skip(!auth, "needs E2E_AUTH_FILE from the live agent test");
  test.describe.configure({ mode: "serial" });

  test("buyer: sees the finished job, downloads its results and invoice", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.buyer);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your dashboard");
    await expect(page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Admin" })).toHaveCount(0);

    await page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Jobs", exact: true }).click();
    await expect(page.getByRole("region", { name: "Your jobs" })).toContainText("Finished");
    await page.getByRole("region", { name: "Your jobs" }).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/jobs/${auth!.jobId}$`));
    await expect(page.getByText("Finished", { exact: true })).toBeVisible();
    await expect(page.getByText("1 / 1")).toBeVisible();

    const results = await page.request.get(await page.getByRole("link", { name: "Download results (JSON)" }).getAttribute("href").then((h) => h!));
    expect(results.status()).toBe(200);
    expect(((await results.json()) as { items: unknown[] }).items).toHaveLength(20);

    const inv = await page.request.get((await page.getByRole("link", { name: "Invoice (PDF)" }).getAttribute("href"))!);
    expect(inv.status()).toBe(200);
    expect(inv.headers()["content-type"]).toBe("application/pdf");
    const pdf = (await inv.body()).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("Total paid");
  });

  test("buyer: a quote error is shown in the form, and the admin page is a 404", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.buyer);
    await page.goto("/dashboard/jobs/new");
    await page.getByRole("button", { name: "Get a quote" }).click();
    // Scoped to the form: Next.js adds its own (empty) role=alert route announcer.
    const formAlert = page.locator("form").getByRole("alert");
    await expect(formAlert).toHaveText("Add at least one line of text.");
    await page.getByLabel("Kind of PC").selectOption("rtx4090");
    await page.getByLabel("Texts, one per line").fill("first\nsecond");
    await page.getByRole("button", { name: "Get a quote" }).click();
    // No RTX 4090 PCs exist on a fresh preview database.
    await expect(formAlert).toContainText("No RTX 4090 PCs are taking work right now");

    const res = await page.goto("/dashboard/admin");
    expect(res?.status()).toBe(404);
  });

  test("buyer: downloads their data; deleting needs DELETE typed", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.buyer);
    await page.goto("/dashboard/account");
    const href = await page.getByRole("link", { name: "Download my data (JSON)" }).getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toMatch(/^attachment;/);
    const data = (await res.json()) as { account: { email: string }; jobs: Array<{ id: string }> };
    expect(data.account.email).toMatch(/^buyer-/);
    expect(data.jobs.map((j) => j.id)).toContain(auth!.jobId);

    const del = page.getByRole("button", { name: "Delete my account" });
    await expect(del).toBeDisabled();
    await page.getByLabel("Type DELETE to confirm").fill("delete");
    await expect(del).toBeDisabled();
    // Not clicked: the buyer's session is used by the tests that follow.
  });

  test("owner: sees the PC with estimated watts and earnings with electricity separate", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.owner);
    await page.goto("/dashboard/pcs");
    const pc = page.getByRole("region", { name: "CI runner" });
    await expect(pc).toContainText("65 W (estimated, CPU mode)");
    await expect(pc).toContainText("(RTX 3060 = 1000)");
    await expect(pc).toContainText("All day");

    await page.goto("/dashboard/earnings");
    const byPc = page.getByRole("region", { name: "Earnings by PC" });
    await expect(byPc).toContainText("CI runner");
    await expect(page.getByText("Electricity paid back")).toBeVisible();
    await expect(page.getByRole("region", { name: "Every piece your PCs ran" })).toContainText("CI runner");
  });

  test("owner: adds a PC, sees its token once, pauses it and removes it", async ({ page, context, baseURL }, info) => {
    // Unique per browser and retry: the same owner is shared across runs.
    const name = `E2E laptop ${info.project.name} ${info.retry} ${Date.now() % 100000}`;
    await signIn(context, baseURL, auth!.owner);
    await page.goto("/dashboard/pcs");
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Kind", { exact: true }).selectOption("cpu");
    await page.getByRole("button", { name: "Add PC" }).click();
    await expect(page.getByText(/^nsn_[A-Za-z0-9_-]{43}$/)).toBeVisible();
    await page.getByRole("button", { name: "I've saved it" }).click();
    await expect(page.getByText(/^nsn_/)).toHaveCount(0);

    const pc = page.getByRole("region", { name, exact: true });
    await pc.getByRole("button", { name: "Pause" }).click();
    await expect(pc.getByRole("button", { name: "Resume" })).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await pc.getByRole("button", { name: "Remove" }).click();
    await expect(pc).toContainText("Removed");
  });

  test("admin: sees every section of the admin panel", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.admin);
    await page.goto("/dashboard");
    await page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Admin" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Admin");
    for (const h of ["Quarantine list", "PCs", "Jobs", "Ledger", "Audit log"]) {
      await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
    }
    await expect(page.getByRole("region", { name: "All jobs" })).toContainText(auth!.jobId.slice(0, 8));
    await expect(page.getByRole("region", { name: "Audit log entries" })).toContainText("job.confirmed");
  });

  test("every dashboard page has one h1 and no serious accessibility issues", async ({ page, context, baseURL }) => {
    test.setTimeout(120_000); // eight pages, each with a full axe scan
    await signIn(context, baseURL, auth!.admin);
    for (const path of DASHBOARD_PAGES) {
      await page.goto(path);
      await expect(page.locator("h1"), path).toHaveCount(1);
      await expect(page.locator("main#main"), path).toHaveCount(1);
      await noSeriousA11yIssues(page);
    }
    await signIn(context, baseURL, auth!.buyer);
    await page.goto(`/dashboard/jobs/${auth!.jobId}`);
    await noSeriousA11yIssues(page);
  });
});
