"use server";

import { formField } from "@/lib/form";
import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { z } from "zod";
import { googleLoginAvailable, signIn } from "@/lib/auth";
import { checkLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/security/tokens";

export interface SignInState {
  error?: string;
}

const emailSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
});

export async function signInWithEmail(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = emailSchema.safeParse({ email: formField(formData, "email") });
  if (!parsed.success) return { error: "That email address doesn't look right." };

  const r = await checkLimit("loginIp", clientIp(await headers()));
  if (!r.success) return { error: "Too many login attempts. Wait a few minutes and try again." };

  try {
    // On success this throws a redirect to /signin/check-email, which must
    // propagate, so only Auth.js errors are caught.
    await signIn("resend", { email: parsed.data.email, redirectTo: "/dashboard" });
  } catch (err) {
    if (err instanceof AuthError) return { error: "We couldn't send the link. Try again in a minute." };
    throw err;
  }
  return {};
}

export async function signInWithGoogle(): Promise<void> {
  if (!(await googleLoginAvailable())) return;
  const r = await checkLimit("loginIp", clientIp(await headers()));
  if (!r.success) return;
  await signIn("google", { redirectTo: "/dashboard" });
}
