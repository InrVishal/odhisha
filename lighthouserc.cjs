// Lighthouse CI: every public page must score 90+ in every category
// (median of 3 runs). LHCI_BASE_URL is the deployment URL (set by CI).
//
// Vercel adds `X-Robots-Tag: noindex` to preview deployments, so the SEO
// "is-crawlable" audit always fails there. On previews we skip that one audit;
// the production run after deploy checks it (LHCI_PRODUCTION=1).
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
if (!isProduction) settings.skipAudits = ["is-crawlable"];

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
