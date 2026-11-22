// Lighthouse CI: every public page must score 90+ in every category.
// LHCI_BASE_URL is the preview deployment URL (set by CI).
const base = process.env.LHCI_BASE_URL || "http://localhost:3000";
const publicPaths = ["/", "/signin"]; // phase 2 adds every marketing page

const extraHeaders = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? JSON.stringify({ "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET })
  : undefined;

module.exports = {
  ci: {
    collect: {
      url: publicPaths.map((p) => new URL(p, base).toString()),
      numberOfRuns: 3,
      settings: extraHeaders ? { extraHeaders } : {},
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.9 }],
        "categories:best-practices": ["error", { minScore: 0.9 }],
        "categories:seo": ["error", { minScore: 0.9 }],
      },
    },
    upload: { target: "temporary-public-storage" },
  },
};
