import { afterEach, describe, expect, it, vi } from "vitest";
import { magicLinkText, sendMagicLink } from "@/lib/auth/email";
import { parseEnv } from "@/lib/env";

const base = { DATABASE_URL: "pglite:memory", AUTH_SECRET: "x".repeat(40), CRON_SECRET: "x".repeat(40) };

describe("magic link email", () => {
  afterEach(() => vi.restoreAllMocks());

  it("text contains the link and the expiry", () => {
    const t = magicLinkText("https://nightshift.test/api/auth/callback/resend?token=abc");
    expect(t).toContain("https://nightshift.test/api/auth/callback/resend?token=abc");
    expect(t).toContain("15 minutes");
  });

  it("console transport logs instead of sending", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendMagicLink(parseEnv(base), "a@b.in", "https://x/link");
    expect(log).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resend transport posts plain text and hides the provider's error body", async () => {
    const env = parseEnv({ ...base, EMAIL_TRANSPORT: "resend", AUTH_RESEND_KEY: "re_k" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response('{"to":"a@b.in"}', { status: 422 }));

    await sendMagicLink(env, "a@b.in", "https://x/link");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ to: "a@b.in", subject: "Your NightShift login link" });
    expect(body.html).toBeUndefined();

    await expect(sendMagicLink(env, "a@b.in", "https://x/link")).rejects.toThrow(/^email provider returned 422$/);
  });

  it("previews send only to PREVIEW_EMAIL_ALLOWLIST, so a scanner can't make them send mail", async () => {
    const env = { ...parseEnv({ ...base, EMAIL_TRANSPORT: "resend", AUTH_RESEND_KEY: "re_k", PREVIEW_EMAIL_ALLOWLIST: "Tester@CI.test" }), APP_ENV: "preview" as const };
    expect(env.PREVIEW_EMAIL_ALLOWLIST).toEqual(["tester@ci.test"]);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await sendMagicLink(env, "zaproxy@example.com", "https://x/link");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).not.toContain("zaproxy");

    await sendMagicLink(env, "tester@ci.test", "https://x/link");
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Production has no allowlist: everyone can log in.
    await sendMagicLink({ ...env, APP_ENV: "production" }, "someone@example.in", "https://x/link");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
