import type { MetadataRoute } from "next";
import { allPages } from "@/content/site";
import { siteUrl } from "@/lib/site-url";

function base(): string {
  return siteUrl().origin;
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: allPages.map((p) => p.path), disallow: ["/api/", "/dashboard", "/signin"] },
    sitemap: `${base()}/sitemap.xml`,
  };
}
