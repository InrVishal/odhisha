"use server";

import { formField } from "@/lib/form";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { submitAdminCode } from "@/lib/admin-access";
import { ipHashSecret, signOut } from "@/lib/auth";
import { currentAdminAccess } from "@/lib/auth/guards";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { checkLimit } from "@/lib/ratelimit";
import { getKeys } from "@/lib/security/keys";
import { clientIp } from "@/lib/security/tokens";

/*
 * Admin check 3 of 3: every admin server action checks for itself. A server
 * action is a public POST endpoint: anyone who learns its ID can call it, so
 * the layout and page checks protect nothing here.
 */

export interface CodeState {
  error?: string;
}

const codeInput = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/) });

const STALE = "Your login is more than 15 minutes old. Log in again to use admin.";

/** Checks the authenticator code (and, the first time, confirms the setup). */
export async function submitAdminCodeAction(_prev: CodeState, formData: FormData): Promise<CodeState> {
  const access = await currentAdminAccess();
  if (access.state === "not_admin") notFound();
  if (access.state === "stale_login") return { error: STALE };
  const limited = await checkLimit("adminMfaUser", access.userId);
  if (!limited.success) return { error: limited.unavailable ? "Admin codes are briefly unavailable. Try again in a few minutes." : "Too many tries. Wait 15 minutes and try again." };
  const parsed = codeInput.safeParse({ code: formField(formData, "code") });
  if (!parsed.success) return { error: "Enter the 6-digit code from your authenticator app." };
  const env = getEnv();
  const result = await submitAdminCode(
    await getDb(),
    {
      session: access.session,
      allowlist: env.ADMIN_EMAILS,
      now: new Date(),
      masterKey: (await getKeys()).dataKey,
      ipSecret: ipHashSecret(),
      ip: clientIp(await headers()),
    },
    parsed.data.code,
  );
  if (result === "not_found") notFound();
  if (result === "stale_login") return { error: STALE };
  if (result === "wrong") return { error: "That code didn't work. Check your phone's clock, wait for the next code and try again." };
  redirect("/admin");
}

/** Admin pages need a login from the last 15 minutes: log out so the admin can log in again. */
export async function logInAgainAction(): Promise<void> {
  const access = await currentAdminAccess();
  if (access.state === "not_admin") notFound();
  await signOut({ redirectTo: "/signin" });
}
