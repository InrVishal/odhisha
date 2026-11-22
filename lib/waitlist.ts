import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { waitlist } from "@/lib/db/schema";

export const waitlistInput = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  interest: z.enum(["owner", "buyer", "both"]),
  // A checkbox sends "on" when ticked and nothing when not.
  consent: z.literal("on"),
});

export type WaitlistInput = z.infer<typeof waitlistInput>;

/**
 * Adds an email to the waitlist. Signing up twice is a no-op, and the caller
 * shows the same message either way, so the form can't be used to find out
 * whether someone is already on the list.
 */
export async function joinWaitlist(db: Db, input: WaitlistInput, now = new Date()): Promise<void> {
  await db
    .insert(waitlist)
    .values({ email: input.email, interest: input.interest, consentAt: now })
    .onConflictDoNothing({ target: waitlist.email });
}
