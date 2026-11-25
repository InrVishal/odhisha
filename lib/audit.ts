import type { Db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { hashIp } from "@/lib/security/tokens";

/** Every audited action. Adding one here is the only way to log a new kind. */
export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.logout",
  "auth.logout_all",
  "auth.login_rate_limited",
  "node.registered",
  "node.updated",
  "node.token_created",
  "node.token_revoked",
  "node.quarantined",
  "node.released",
  "node.canary_failed",
  "node.replay_rejected",
  "node.watts_clamped",
  "job.confirmed",
  "job.refunded",
  "job.piece_corrected",
  "sybil.flagged",
  "account.upi_linked",
  "credits.clawed_back",
  "payout.created",
  "admin.action",
  "admin.viewed",
  "admin.mfa_enrolled",
  "admin.mfa_verified",
  "admin.mfa_failed",
  /** Written by the database trigger on "user".role (migration 0008), never by the app. */
  "admin.role_changed",
  "admin.role_change_refused",
  "canary.cover_passed",
  "canary.cover_failed",
  "account.exported",
  "account.deleted",
  /** Degraded operation the owner must hear about now (lib/ops-alert.ts); target_id is the kind. */
  "ops.alert",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEvent {
  actorId: string | null;
  actorType: "user" | "admin" | "node" | "system";
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ip?: string;
  /** Never put emails, tokens or IPs in here. */
  meta?: Record<string, string | number | boolean | null>;
}

export async function audit(db: Db, event: AuditEvent, ipSecret: string): Promise<void> {
  await db.insert(auditLog).values({
    actorId: event.actorId,
    actorType: event.actorType,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    ipHash: event.ip && event.ip !== "unknown" ? hashIp(event.ip, ipSecret) : null,
    meta: event.meta ?? null,
  });
}
