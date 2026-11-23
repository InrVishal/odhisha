import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { totpCode } from "../../lib/security/totp";
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

const DASHBOARD_PAGES = [
  "/dashboard",
  "/dashboard/jobs",
  "/dashboard/jobs/new",
  "/dashboard/pcs",
  "/dashboard/earnings",
  "/dashboard/credits",
  "/dashboard/emi",
  "/dashboard/account",
];

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

/**
 * The admin server actions' IDs, from this build's manifest (the preview job
 * builds the app, so it's on disk there). Anyone can find an action's ID in
 * a bundle and POST to it: these tests call them directly.
 */
function adminActionIds(): Record<string, string> {
  const file = path.resolve(".next/server/server-reference-manifest.json");
  if (!existsSync(file)) return {};
  const m = JSON.parse(readFileSync(file, "utf8")) as { node: Record<string, { filename?: string; exportedName?: string }> };
  return Object.fromEntries(Object.entries(m.node).filter(([, v]) => v.filename === "app/admin/actions.ts").map(([id, v]) => [v.exportedName!, id]));
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
    // The live test's second agent re-ran the piece on another PC.
    await expect(page.getByRole("region", { name: "Checks" })).toContainText("1 matched.");

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

  for (const who of ["buyer", "owner"] as const) {
    test(`${who}: /admin, the admin API and admin server actions called by ID are all a 404`, async ({ page, context, baseURL }) => {
      await signIn(context, baseURL, auth![who]);
      for (const p of ["/admin", "/admin/anything"]) {
        const res = await page.goto(p);
        expect(res?.status(), p).toBe(404);
        await expect(page.getByText(/authenticator|Quarantine list/)).toHaveCount(0);
      }
      const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
      const req = page.request;
      const api = "/api/admin/nodes/00000000-0000-4000-8000-000000000000/release";
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const r = await req.fetch(api, { method, headers: { cookie, origin: baseURL! } });
        expect(r.status(), `${method} ${api}`).toBe(404);
      }
      // Spoofed headers don't help.
      const spoofed = await page.request.get("/admin", { headers: { cookie, "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware", "x-user-role": "admin" } });
      expect(spoofed.status()).toBe(404);
      // The actions themselves, called by ID: refused with the same 404.
      const ids = adminActionIds();
      test.skip(!ids.logInAgainAction, "this run has no build manifest on disk");
      const noArgs = await req.post("/admin", { headers: { cookie, origin: baseURL!, "next-action": ids.logInAgainAction!, "content-type": "text/plain;charset=UTF-8" }, data: "[]" });
      expect(noArgs.status(), "logInAgainAction").toBe(404);
      const form = await req.post("/admin", {
        headers: { cookie, origin: baseURL!, "next-action": ids.submitAdminCodeAction! },
        multipart: { "0": '[{},"$K1"]', "1_code": "123456" },
      });
      expect(form.status(), "submitAdminCodeAction").toBe(404);
      // Still nothing afterwards.
      expect((await page.goto("/admin"))?.status()).toBe(404);
    });
  }

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
    // Speed comes from NightShift's own timed challenges; the PC's own number is shown, not used.
    await expect(pc).toContainText("Speed, measured by NightShift");
    await expect(pc).toContainText("(shown only, not used)");
    await expect(pc).toContainText("All day");
    await expect(pc).toContainText("520 / 1000");
    await expect(pc).toContainText("1 passed, 0 failed");
    // A new PC: half its pieces are re-run. This one earns Time-Bank credits.
    await expect(pc).toContainText("50% (new PC: 1 of its first 20 pieces done)");
    await expect(pc).toContainText("Time-Bank credits (electricity still paid in rupees)");

    await page.goto("/dashboard/earnings");
    // Every dashboard page says money is simulated.
    await expect(page.getByText(/Demo mode: payments, UPI payouts and GPU EMI are simulated. No real money moves./)).toBeVisible();
    const byPc = page.getByRole("region", { name: "Earnings by PC" });
    await expect(byPc).toContainText("CI runner");
    await expect(page.getByText("Electricity paid back")).toBeVisible();
    await expect(page.getByRole("region", { name: "Every piece your PCs ran" })).toContainText("CI runner");

    // Payout UPI ID: linked once per account, shown masked.
    await page.getByLabel(/^(UPI ID|Change UPI ID)$/).fill("ci.owner@okaxis");
    await page.getByRole("button", { name: /^(Link UPI ID|Change)$/ }).click();
    await expect(page.getByRole("status")).toHaveText("Linked ci•••@okaxis.");
    await expect(page.getByText("Payout UPI ID: ci•••@okaxis")).toBeVisible();
  });

  test("owner: the Time-Bank wallet shows the verified credits from the checked piece", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.owner);
    await page.goto("/dashboard/credits");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Time-Bank");
    await expect(page.getByText(/Demo mode: payments, UPI payouts and GPU EMI are simulated/)).toBeVisible();
    const available = page.getByText("Available to spend").locator("..");
    await expect(available).toContainText(/[1-9][0-9.]* standard GPU-(second|minute|hour)/);
    await expect(page.getByRole("region", { name: "Time-Bank history" })).toContainText("Earned");
    await expect(page.getByText(/can.t be cashed out, sold or given to anyone/)).toBeVisible();
  });

  test("owner: the EMI simulator works out the EMI, takes electricity out first, and says it's a demo", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.owner);
    await page.goto("/dashboard/emi");
    await expect(page.getByRole("note")).toContainText("Demo mode: this is a simulator. NightShift doesn't lend money");
    const result = page.getByRole("region", { name: "Result" });
    // The defaults: ₹26,000 at 15% for 12 months; 8 h × 30 nights × 40% at ₹25/h (the pricing page's rate), 320 W at ₹9/kWh.
    await expect(result).toContainText("₹2,346.72");
    await expect(result).toContainText("₹2,400");
    await expect(result).toContainText("minus ₹276.48 for electricity");
    await expect(result).toContainText("102%");
    await expect(result).toContainText("not guaranteed");
    // Payoff at 20%, 40% and 70%: 24, 12 and 7 months.
    const scenarios = page.getByRole("region", { name: "Payoff at 20%, 40% and 70% of night hours with work" });
    await expect(scenarios.getByRole("row")).toHaveText([/Night hours with work/, /^20%.*24$/, /^40%.*12$/, /^70%.*7$/]);
    await page.getByLabel(/Share of those hours with work/).fill("0");
    await expect(result).toContainText("Not within 10 years");
    await page.getByLabel("Interest (% a year)").fill("abc");
    // Scoped to the page: the route announcer is an alert too.
    await expect(page.locator("main#main").getByRole("alert")).toContainText("Interest must be a yearly rate");
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

  test("admin: a fresh login, then an authenticator code, then every section of the admin panel", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, auth!.admin);
    await page.goto("/dashboard");
    await page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Admin" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    // First visit: set up the second factor (as a person would, from the setup key on the page).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up your authenticator");
    await noSeriousA11yIssues(page);
    const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "");
    await page.getByLabel("Code from the app").fill("000000");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("main#main").getByRole("alert")).toContainText("That code didn't work");
    await page.getByLabel("Code from the app").fill(totpCode(secret, new Date()));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Admin");
    await noSeriousA11yIssues(page);
    for (const h of ["Quarantine list", "PCs", "Jobs", "Ledger", "Possible fake accounts", "Audit log"]) {
      await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
    }
    await expect(page.getByRole("region", { name: "All jobs" })).toContainText(auth!.jobId.slice(0, 8));
    await expect(page.getByRole("region", { name: "Audit log entries" })).toContainText("job.confirmed");
    // The two CI agents run on one machine under two accounts: flagged.
    await expect(page.getByRole("region", { name: "Flagged accounts" })).toContainText(/Same device|Same network/);
    // Setting up the authenticator and viewing the panel were logged.
    await page.reload();
    await expect(page.getByRole("region", { name: "Audit log entries" })).toContainText("admin.mfa_enrolled");
    await expect(page.getByRole("region", { name: "Audit log entries" })).toContainText("admin.viewed");
  });

  test("every dashboard page has one h1 and no serious accessibility issues", async ({ page, context, baseURL }) => {
    test.setTimeout(180_000); // ten pages, each with a full axe scan
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
