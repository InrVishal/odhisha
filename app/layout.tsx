import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { site } from "@/content/site";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

function siteUrl(): URL {
  if (process.env.SITE_URL) return new URL(process.env.SITE_URL);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL("http://localhost:3000");
}

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: `${site.name}: your GPU earns while you sleep`, template: `%s · ${site.name}` },
  description: site.tagline,
  openGraph: { siteName: site.name, type: "website", locale: "en_IN" },
};

export const viewport: Viewport = { themeColor: "#0e1a36", colorScheme: "dark" };

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Reading request headers makes every page render per request, which the
  // nonce-based CSP needs. Next.js reads the nonce from the CSP header itself.
  await headers();
  return (
    <html lang="en-IN" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only rounded bg-orange px-4 py-2 font-semibold text-deep focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
        >
          {site.skipLink}
        </a>
        {children}
      </body>
    </html>
  );
}
