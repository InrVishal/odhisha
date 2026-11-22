import { formatPaise } from "@/lib/pricing";

/** ₹ amounts for the dashboards. */
export const rupees = (paise: number) => formatPaise(paise);

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** "22 Nov, 11:30 pm" in India time. */
export function when(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return DATE_TIME.format(typeof d === "string" ? new Date(d) : d);
}

/** 1380 → "23:00". */
export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function windowText(startMin: number, endMin: number): string {
  return startMin === endMin ? "All day" : `${hhmm(startMin)} to ${hhmm(endMin)}`;
}

export const shortId = (id: string) => id.slice(0, 8);

export const JOB_STATUS: Record<string, string> = {
  quoted: "Quote (not confirmed)",
  queued: "Waiting for a PC",
  running: "Running",
  completed: "Finished",
  deadline_missed: "Missed the deadline (refunded)",
  failed: "Couldn't finish (refunded)",
  cancelled: "Cancelled",
};

export const NODE_STATUS: Record<string, string> = {
  pending: "Waiting for the agent",
  online: "Online",
  offline: "Offline",
  quarantined: "Paused by NightShift",
  revoked: "Removed",
};

/** Why a PC isn't taking work, in words. */
export const UNAVAILABLE: Record<string, string> = {
  not_online: "agent not connected",
  paused: "paused",
  stale: "no heartbeat in the last few minutes",
  low_trust: "trust score too low",
  outside_window: "outside its night window",
};
