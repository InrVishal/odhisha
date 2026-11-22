import { priceJob } from "@/lib/pricing";
import { benchmarkFor, wattsFor, type NodeClass } from "./classes";
import { estimateSeconds, type WorkloadSpec } from "./workloads";

/**
 * Scheduling maths. Pure functions, no I/O: everything the coordinator
 * decides about WHO runs WHAT and WHEN is in here, so it can be unit-tested.
 */

/** A node that hasn't sent a heartbeat for this long is treated as offline. */
export const HEARTBEAT_TIMEOUT_SEC = 90;
/** Below this trust score a node gets no work (phase 6 moves scores). */
export const MIN_TRUST_FOR_WORK = 200;
/** Quotes are honoured for this long. */
export const QUOTE_TTL_SEC = 10 * 60;
/** Job data is deleted this long after a job ends. */
export const RETENTION_SEC = 7 * 24 * 3600;
/** Safety margin added to every planned finish time, before rounding. */
export const DEADLINE_MARGIN_SEC = 10 * 60;
export const DEADLINE_SLACK_FACTOR = 1.5;
export const DEADLINE_ROUND_SEC = 15 * 60;
export const MAX_LEASE_SEC = 6 * 3600;

// ─── Night windows ─────────────────────────────────────────────────────────

export interface NightWindow {
  /** Minutes after local midnight, 0..1439. start === end means all day. */
  startMin: number;
  endMin: number;
  timezone: string;
}

/** Local minutes after midnight in `timezone`, and seconds into that minute. */
export function localClock(now: Date, timezone: string): { minutes: number; seconds: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { minutes: get("hour") * 60 + get("minute"), seconds: get("second") };
}

/** Is `now` inside the window [start, end)? Windows may wrap past midnight. */
export function inNightWindow(now: Date, w: NightWindow): boolean {
  if (w.startMin === w.endMin) return true;
  const m = localClock(now, w.timezone).minutes;
  return w.startMin < w.endMin ? m >= w.startMin && m < w.endMin : m >= w.startMin || m < w.endMin;
}

/**
 * When the current window closes, or null for an all-day window. Only
 * meaningful while inside the window.
 */
export function windowEndsAt(now: Date, w: NightWindow): Date | null {
  if (w.startMin === w.endMin) return null;
  const { minutes, seconds } = localClock(now, w.timezone);
  const minutesLeft = (w.endMin - minutes + 1440) % 1440 || 1440;
  return new Date(now.getTime() + (minutesLeft * 60 - seconds) * 1000 - (now.getTime() % 1000));
}

// ─── Nodes ─────────────────────────────────────────────────────────────────

export interface NodeView {
  id: string;
  nodeClass: NodeClass;
  status: "pending" | "online" | "offline" | "quarantined" | "revoked";
  paused: boolean;
  lastSeenAt: Date | null;
  trustScore: number;
  benchmarkScore: number | null;
  measuredWatts: number | null;
  tariffPaisePerKwh: number;
  ownerRatePaisePerHr: number;
  window: NightWindow;
}

export type Unavailable = "not_online" | "paused" | "stale" | "low_trust" | "outside_window";

/** Why a node can't take work right now, or null if it can. */
export function unavailableReason(node: NodeView, now: Date): Unavailable | null {
  if (node.status !== "online") return "not_online";
  if (node.paused) return "paused";
  if (!node.lastSeenAt || now.getTime() - node.lastSeenAt.getTime() > HEARTBEAT_TIMEOUT_SEC * 1000) return "stale";
  if (node.trustScore < MIN_TRUST_FOR_WORK) return "low_trust";
  if (!inNightWindow(now, node.window)) return "outside_window";
  return null;
}

export function nodeBenchmark(node: Pick<NodeView, "nodeClass" | "benchmarkScore">): number {
  return benchmarkFor(node.nodeClass, node.benchmarkScore);
}

export function nodeWatts(node: Pick<NodeView, "nodeClass" | "measuredWatts">): number {
  return wattsFor(node.nodeClass, node.measuredWatts);
}

/**
 * Matching score: faster first, then more work per watt, then more trusted.
 * score = benchmark × √(benchmark / watts) × trust / 1000.
 * Used to pick which nodes a quote is planned on, and to order them.
 */
export function matchScore(node: NodeView): number {
  const b = nodeBenchmark(node);
  return b * Math.sqrt(b / nodeWatts(node)) * (node.trustScore / 1000);
}

/** The most a node may cost per second to take a job: its price cap. */
export interface CostCap {
  /** watts × tariff (paise per kWh), the power-cost rate. */
  maxWattTariff: number;
  maxOwnerRate: number;
}

export function wattTariff(node: NodeView): number {
  return nodeWatts(node) * node.tariffPaisePerKwh;
}

/** A node may run a job's fragments only if it costs no more than the quote assumed. */
export function withinCap(node: NodeView, cap: CostCap): boolean {
  return wattTariff(node) <= cap.maxWattTariff && node.ownerRatePaisePerHr <= cap.maxOwnerRate;
}

// ─── Planning a quote ──────────────────────────────────────────────────────

export interface Plan {
  /** Seconds from now until the last fragment is expected to finish. */
  makespanSec: number;
  finishAt: Date;
  /** Latest time any planned node's window closes (null = all day). */
  latestWindowEnd: Date | null;
  nodesUsed: number;
}

/**
 * List scheduling, biggest fragment first: each fragment goes to the node
 * that would finish it earliest, if that's before the node's window closes.
 * Returns null if some fragment fits on no node tonight.
 */
export function planFragments(
  spec: WorkloadSpec,
  fragmentItemCounts: readonly number[],
  nodes: readonly NodeView[],
  now: Date,
): Plan | null {
  if (nodes.length === 0 || fragmentItemCounts.length === 0) return null;
  const slots = [...nodes]
    .sort((a, b) => matchScore(b) - matchScore(a))
    .map((n) => ({ node: n, freeAt: 0, used: false, closesIn: secondsUntil(now, windowEndsAt(now, n.window)) }));
  const order = [...fragmentItemCounts].sort((a, b) => b - a);
  for (const items of order) {
    let best: (typeof slots)[number] | null = null;
    let bestFinish = Infinity;
    for (const s of slots) {
      const finish = s.freeAt + estimateSeconds(spec, items, nodeBenchmark(s.node));
      if (finish <= s.closesIn && finish < bestFinish) {
        best = s;
        bestFinish = finish;
      }
    }
    if (!best) return null;
    best.freeAt = bestFinish;
    best.used = true;
  }
  const used = slots.filter((s) => s.used);
  const makespanSec = Math.max(...used.map((s) => s.freeAt));
  const ends = used.map((s) => s.closesIn);
  const latest = Math.max(...ends);
  return {
    makespanSec,
    finishAt: new Date(now.getTime() + makespanSec * 1000),
    latestWindowEnd: latest === Infinity ? null : new Date(now.getTime() + latest * 1000),
    nodesUsed: used.length,
  };
}

function secondsUntil(now: Date, t: Date | null): number {
  return t ? Math.floor((t.getTime() - now.getTime()) / 1000) : Infinity;
}

/**
 * The guaranteed finish time we quote: the planned finish with 50% slack plus
 * 10 minutes (room for a retry or a backup copy), rounded up to the quarter
 * hour so it reads like "done by 6:00 AM".
 */
export function quotedDeadline(now: Date, makespanSec: number): Date {
  const raw = now.getTime() + Math.ceil(makespanSec * DEADLINE_SLACK_FACTOR + DEADLINE_MARGIN_SEC) * 1000;
  const step = DEADLINE_ROUND_SEC * 1000;
  return new Date(Math.ceil(raw / step) * step);
}

// ─── Leases and backups ────────────────────────────────────────────────────

/** How long a node holds a fragment before it's handed to someone else. */
export function leaseSeconds(expectedSec: number): number {
  return Math.min(MAX_LEASE_SEC, Math.ceil(expectedSec * 2) + 120);
}

/**
 * Backup execution: start a second copy of a running fragment when it's
 * running slow AND the deadline is near. "Slow": 25% past its expected time
 * (plus 30 s of grace). "Near": within 15 minutes of the deadline, or in the
 * last quarter of the job's time.
 */
export function needsBackup(args: {
  now: Date;
  deadline: Date;
  confirmedAt: Date;
  startedAt: Date;
  expectedSec: number;
}): boolean {
  const now = args.now.getTime();
  const elapsedSec = (now - args.startedAt.getTime()) / 1000;
  const slow = elapsedSec > args.expectedSec * 1.25 + 30;
  const remainingSec = (args.deadline.getTime() - now) / 1000;
  const totalSec = (args.deadline.getTime() - args.confirmedAt.getTime()) / 1000;
  const near = remainingSec <= Math.max(15 * 60, totalSec * 0.25);
  return slow && near && remainingSec > 0;
}

// ─── Owner pay per fragment ────────────────────────────────────────────────

export interface FragmentPay {
  ownerPayPaise: number;
  electricityPaise: number;
}

/**
 * What the owner of `node` is paid for finishing a fragment that was priced
 * at `gpuSeconds`: their own rate plus their own electricity (measured watts
 * once reported), each rounded up to the paisa. Fixed per fragment: a slow
 * machine doesn't earn more for being slow.
 */
export function fragmentPay(node: NodeView, gpuSeconds: number): FragmentPay {
  const b = priceJob(
    [{ gpuSeconds, watts: nodeWatts(node), tariffPaisePerKwh: node.tariffPaisePerKwh, ownerRatePaisePerHr: node.ownerRatePaisePerHr }],
    { roundPerFragment: true },
  );
  return { ownerPayPaise: b.ownerPayPaise, electricityPaise: b.electricityPaise };
}

/** Rolling average of reported watts (weights the newest report 20%). */
export function nextMeasuredWatts(previous: number | null, reported: number): number {
  if (!previous) return reported;
  return Math.max(1, Math.round(previous * 0.8 + reported * 0.2));
}
