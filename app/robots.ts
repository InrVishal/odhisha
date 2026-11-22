import type { MetadataRoute } from "next";
import { allPages } from "@/content/site";

function base(): string {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: allPages.map((p) => p.path), disallow: ["/api/", "/dashboard", "/signin"] },
    sitemap: `${base()}/sitemap.xml`,
  };
}
