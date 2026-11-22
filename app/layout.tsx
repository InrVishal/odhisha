import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NightShift",
  description: "Idle gaming PCs and college lab GPUs, pooled overnight for AI jobs.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Reading request headers makes every page render per request, which the
  // nonce-based CSP needs. Next.js reads the nonce from the CSP header itself.
  await headers();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
