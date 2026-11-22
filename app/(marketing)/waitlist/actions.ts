"use server";

import { headers } from "next/headers";
import { waitlist as copy } from "@/content/site";
import { getDb } from "@/lib/db";
import { checkLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/security/tokens";
import { joinWaitlist, waitlistInput } from "@/lib/waitlist";

export interface WaitlistState {
  status: "idle" | "done" | "error";
  errors?: Partial<Record<"email" | "interest" | "consent" | "form", string>>;
}

export async function joinWaitlistAction(_prev: WaitlistState, formData: FormData): Promise<WaitlistState> {
  const parsed = waitlistInput.safeParse({
    email: formData.get("email"),
    interest: formData.get("interest"),
    consent: formData.get("consent"),
  });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    return {
      status: "error",
      errors: {
        ...(fields.has("email") ? { email: copy.errors.email } : {}),
        ...(fields.has("interest") ? { interest: copy.errors.interest } : {}),
        ...(fields.has("consent") ? { consent: copy.errors.consent } : {}),
      },
    };
  }

  const r = await checkLimit("waitlistIp", clientIp(await headers()));
  if (!r.success) return { status: "error", errors: { form: copy.errors.rateLimited } };

  try {
    await joinWaitlist(await getDb(), parsed.data);
  } catch {
    return { status: "error", errors: { form: copy.errors.generic } };
  }
  return { status: "done" };
}
