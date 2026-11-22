// Lighthouse CI: every public page must score 90+ in every category
// (median of 3 runs). LHCI_BASE_URL is the deployment URL (set by CI).
//
// Two SEO audits can't pass on a Vercel preview, whatever the site does:
// - "is-crawlable": Vercel adds `X-Robots-Tag: noindex` to every preview.
// - "robots-txt": previews sit behind Deployment Protection. Lighthouse sends
//   the bypass header with page loads but fetches /robots.txt on its own,
//   without it, and gets a 302 to the Vercel login.
// On previews we skip just those two. Both are still covered: the production
// run after deploy (LHCI_PRODUCTION=1) checks them, and the E2E suite fetches
// /robots.txt and /sitemap.xml from every preview with the bypass header.
//
// Reports stay on the CI runner (uploaded as a private artifact). Public
// report storage is off: report settings would include the Vercel
// protection-bypass header.
const base = process.env.LHCI_BASE_URL || "http://localhost:3000";
const isProduction = process.env.LHCI_PRODUCTION === "1";

const publicPaths = ["/", "/how-it-works", "/owners", "/builders", "/pricing", "/time-bank", "/faq", "/waitlist", "/privacy", "/terms"];

const settings = {};
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
  settings.extraHeaders = JSON.stringify({ "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET });
}
if (!isProduction) settings.skipAudits = ["is-crawlable", "robots-txt"];

module.exports = {
  ci: {
    collect: {
      url: publicPaths.map((p) => new URL(p, base).toString()),
      numberOfRuns: 3,
      settings,
    },
    assert: {
      aggregationMethod: "median-run",
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.9 }],
        "categories:best-practices": ["error", { minScore: 0.9 }],
        "categories:seo": ["error", { minScore: 0.9 }],
      },
    },
    upload: { target: "filesystem", outputDir: "./lhci_reports" },
  },
};
