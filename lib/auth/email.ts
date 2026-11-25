import type { Env } from "@/lib/env";

export const MAGIC_LINK_MAX_AGE_SEC = 15 * 60;

export function magicLinkText(url: string): string {
  return [
    "Here is your link to log in to NightShift:",
    "",
    url,
    "",
    "It works once and stops working in 15 minutes.",
    "If you didn't ask for this, you can ignore this email. Nobody can log in without the link.",
    "",
    "NightShift",
  ].join("\n");
}

export async function sendMagicLink(env: Env, to: string, url: string): Promise<void> {
  if (env.EMAIL_TRANSPORT === "console") {
    // Dev/test only. Env validation refuses this transport when deployed.
    console.info(`[dev email] login link for ${to}:\n${url}`);
    return;
  }
  if (env.APP_ENV === "preview" && !env.PREVIEW_EMAIL_ALLOWLIST.includes(to.trim().toLowerCase())) {
    // No address in the log: it's personal data, and a scanner's junk anyway.
    console.info("[email] preview: login link not sent (address is not on PREVIEW_EMAIL_ALLOWLIST)");
    return;
  }

  // Plain text only: no HTML means no tracking pixels and nothing to escape.
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AUTH_RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject: "Your NightShift login link", text: magicLinkText(url) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Status only. The response body can echo the recipient address.
    throw new Error(`email provider returned ${res.status}`);
  }
}
