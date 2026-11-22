import type { MetadataRoute } from "next";
import { allPages } from "@/content/site";
import { siteUrl } from "@/lib/site-url";

function base(): string {
  return siteUrl().origin;
}

export default function sitemap(): MetadataRoute.Sitemap {
  return allPages.map((p) => ({ url: new URL(p.path, base()).toString() }));
}
