import { and, asc, eq, gte, inArray, notExists, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { alertSent, auditLog } from "@/lib/db/schema";
import type { Env } from "@/lib/env";

/**
 * Security alerts by email: every change to an account's role (allowed or
 * refused, written by the database trigger), and every new admin second
 * factor. The scheduler tick sends them; each audit row is emailed once.
 * The email has account ids only, no addresses or IPs.
 */

export const ALERT_ACTIONS = ["admin.role_changed", "admin.role_change_refused", "admin.mfa_enrolled"] as const;
const PER_TICK = 20;
/** A failing alert is tried this many times, then left (it stays in the audit log). */
export const ALERT_MAX_ATTEMPTS = 5;

export interface Mailer {
  send(to: readonly string[], subject: string, text: string): Promise<void>;
}

export interface AlertConfig {
  mailer: Mailer | null;
  recipients: readonly string[];
}

/**
 * From the environment: ADMIN_ALERT_EMAIL, or else everyone on ADMIN_EMAILS.
 * Previews only email when ADMIN_ALERT_EMAIL is set: their admins are CI
 * test accounts, and the mail provider would refuse them anyway.
 */
export function alertConfig(env: Env): AlertConfig {
  const recipients = env.ADMIN_ALERT_EMAIL.length ? env.ADMIN_ALERT_EMAIL : env.APP_ENV === "preview" ? [] : env.ADMIN_EMAILS;
  if (env.EMAIL_TRANSPORT === "console") {
    return { recipients, mailer: { send: async (to, subject) => console.info(`[dev email] alert to ${to.length} admin(s): ${subject}`) } };
  }
  return {
    recipients,
    mailer: {
      async send(to, subject, text) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.AUTH_RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
          signal: AbortSignal.timeout(10_000),
        });
        // Status only: the body can echo addresses.
        if (!res.ok) throw new Error(`email provider returned ${res.status}`);
      },
    },
  };
}

function describe(row: typeof auditLog.$inferSelect): { subject: string; text: string } {
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const when = row.at.toISOString();
  if (row.action === "admin.mfa_enrolled") {
    return {
      subject: "NightShift security alert: a new admin authenticator was set up",
      text: `Account ${row.targetId} set up an authenticator app for admin at ${when}.\n\nIf that wasn't you, reset it in the database (delete its admin_totp row) and log that account out everywhere.`,
    };
  }
  const refused = row.action === "admin.role_change_refused";
  return {
    subject: refused ? "NightShift security alert: a role change was refused" : "NightShift security alert: an account's role changed",
    text: [
      `${refused ? "Refused" : "Changed"}: account ${row.targetId}, role ${String(meta.from)} → ${String(meta.to)}`,
      `Database role that tried it: ${String(meta.dbRole)}`,
      `When: ${when}`,
      "",
      refused
        ? "Only the database owner role can change roles. Something tried anyway; the role was left as it was."
        : "If you didn't make this change, set the role back and check who has the database owner password.",
    ].join("\n"),
  };
}

/** Emails alerts not yet sent. Failed sends are tried again on the next tick. */
export async function sendSecurityAlerts(db: Db, config: AlertConfig | undefined): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const due = await db
    .select()
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.action, [...ALERT_ACTIONS]),
        notExists(
          db
            .select({ one: alertSent.auditId })
            .from(alertSent)
            .where(and(eq(alertSent.auditId, auditLog.id), or(inArray(alertSent.status, ["sent", "skipped"]), gte(alertSent.attempts, ALERT_MAX_ATTEMPTS)))),
        ),
      ),
    )
    .orderBy(asc(auditLog.id))
    .limit(PER_TICK);
  for (const row of due) {
    let status: "sent" | "skipped" | "failed";
    if (!config?.mailer || config.recipients.length === 0) {
      status = "skipped";
    } else {
      try {
        const { subject, text } = describe(row);
        await config.mailer.send(config.recipients, subject, text);
        status = "sent";
      } catch {
        status = "failed";
      }
    }
    out[status] += 1;
    await db
      .insert(alertSent)
      .values({ auditId: row.id, status })
      .onConflictDoUpdate({ target: alertSent.auditId, set: { status, attempts: sql`${alertSent.attempts} + 1` } });
  }
  return out;
}
