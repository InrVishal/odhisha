/**
 * The site's canonical origin, for metadata, robots.txt and the sitemap.
 * Never throws: a missing or malformed value (for example a sensitive Vercel
 * variable that a build sees only as a placeholder) falls back instead of
 * failing the build.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  for (const candidate of [env.SITE_URL, env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // try the next one
    }
  }
  return new URL("http://localhost:3000");
}
