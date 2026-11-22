import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CLASS_SPECS } from "@/lib/coordinator/classes";
import {
  fragmentPay,
  inNightWindow,
  leaseSeconds,
  matchScore,
  MAX_LEASE_SEC,
  needsBackup,
  nextMeasuredWatts,
  planFragments,
  quotedDeadline,
  unavailableReason,
  windowEndsAt,
  withinCap,
  wattTariff,
  type NodeView,
} from "@/lib/coordinator/schedule";
import { estimateSeconds, WORKLOADS } from "@/lib/coordinator/workloads";
import { powerCostPerHourPaise, priceJob } from "@/lib/pricing";

const IST = "Asia/Kolkata";
/** 2026-11-22 at hh:mm IST. */
const ist = (hh: number, mm = 0) => new Date(Date.UTC(2026, 10, 22, hh, mm) - 330 * 60_000);

function node(over: Partial<NodeView> = {}): NodeView {
  return {
    id: "n",
    nodeClass: "rtx4070",
    status: "online",
    paused: false,
    lastSeenAt: ist(23, 0),
    trustScore: 500,
    benchmarkScore: null,
    measuredWatts: null,
    tariffPaisePerKwh: 900,
    ownerRatePaisePerHr: 2500,
    window: { startMin: 23 * 60, endMin: 7 * 60, timezone: IST },
    ...over,
  };
}

describe("night windows", () => {
  const w = { startMin: 23 * 60, endMin: 7 * 60, timezone: IST };

  it("handles windows that wrap past midnight", () => {
    expect(inNightWindow(ist(23, 0), w)).toBe(true);
    expect(inNightWindow(ist(2, 30), w)).toBe(true);
    expect(inNightWindow(ist(6, 59), w)).toBe(true);
    expect(inNightWindow(ist(7, 0), w)).toBe(false);
    expect(inNightWindow(ist(12, 0), w)).toBe(false);
    expect(inNightWindow(ist(22, 59), w)).toBe(false);
  });

  it("handles same-day windows and all-day windows", () => {
    const day = { startMin: 9 * 60, endMin: 17 * 60, timezone: IST };
    expect(inNightWindow(ist(9, 0), day)).toBe(true);
    expect(inNightWindow(ist(17, 0), day)).toBe(false);
    expect(inNightWindow(ist(3, 0), { startMin: 0, endMin: 0, timezone: IST })).toBe(true);
  });

  it("uses the node's own time zone", () => {
    // 23:30 IST is 18:00 UTC: outside a 23:00–07:00 window kept in UTC.
    expect(inNightWindow(ist(23, 30), { ...w, timezone: "UTC" })).toBe(false);
  });

  it("knows when the window closes", () => {
    expect(windowEndsAt(ist(23, 0), w)).toEqual(ist(7 + 24, 0));
    expect(windowEndsAt(ist(6, 30), w)).toEqual(ist(7, 0));
    expect(windowEndsAt(ist(3, 0), { startMin: 0, endMin: 0, timezone: IST })).toBeNull();
  });
});

describe("node availability and matching", () => {
  const now = ist(23, 30);
  it("gives work only to online, unpaused, recently seen, trusted nodes inside their window", () => {
    expect(unavailableReason(node({ lastSeenAt: now }), now)).toBeNull();
    expect(unavailableReason(node({ status: "offline", lastSeenAt: now }), now)).toBe("not_online");
    expect(unavailableReason(node({ status: "quarantined", lastSeenAt: now }), now)).toBe("not_online");
    expect(unavailableReason(node({ paused: true, lastSeenAt: now }), now)).toBe("paused");
    expect(unavailableReason(node({ lastSeenAt: new Date(now.getTime() - 91_000) }), now)).toBe("stale");
    expect(unavailableReason(node({ trustScore: 100, lastSeenAt: now }), now)).toBe("low_trust");
    expect(unavailableReason(node({ lastSeenAt: ist(12) }), ist(12))).toBe("outside_window");
  });

  it("ranks faster, more efficient, more trusted nodes higher", () => {
    expect(matchScore(node({ nodeClass: "rtx4090" }))).toBeGreaterThan(matchScore(node({ nodeClass: "rtx4070" })));
    expect(matchScore(node({ measuredWatts: 250 }))).toBeGreaterThan(matchScore(node({ measuredWatts: 450 })));
    expect(matchScore(node({ trustScore: 900 }))).toBeGreaterThan(matchScore(node({ trustScore: 400 })));
    expect(matchScore(node({ benchmarkScore: 2000 }))).toBeGreaterThan(matchScore(node({ benchmarkScore: 1600 })));
  });

  it("keeps nodes that cost more than the quote assumed away from the job", () => {
    const cap = { maxWattTariff: wattTariff(node()), maxOwnerRate: 2500 };
    expect(withinCap(node(), cap)).toBe(true);
    expect(withinCap(node({ ownerRatePaisePerHr: 2501 }), cap)).toBe(false);
    expect(withinCap(node({ measuredWatts: 351 }), cap)).toBe(false);
    expect(withinCap(node({ tariffPaisePerKwh: 901 }), cap)).toBe(false);
    expect(withinCap(node({ tariffPaisePerKwh: 800, measuredWatts: 390 }), cap)).toBe(true);
  });
});

describe("planning and the quoted deadline", () => {
  const spec = WORKLOADS.text_embeddings;
  const now = ist(23, 0);

  it("spreads fragments over nodes so more nodes finish sooner", () => {
    const counts = Array(8).fill(250);
    const one = planFragments(spec, counts, [node()], now)!;
    const four = planFragments(spec, counts, [node({ id: "a" }), node({ id: "b" }), node({ id: "c" }), node({ id: "d" })], now)!;
    expect(four.makespanSec).toBeLessThan(one.makespanSec);
    expect(four.nodesUsed).toBe(4);
    expect(one.makespanSec).toBe(8 * estimateSeconds(spec, 250, CLASS_SPECS.rtx4070.defaultBenchmark));
  });

  it("refuses work that can't finish before the window closes", () => {
    // One 250-text piece takes 31 s on an RTX 4070. 20 s before 7:00 it can't finish.
    const late = new Date(ist(7, 0).getTime() - 20_000);
    expect(planFragments(spec, [250], [node()], late)).toBeNull();
    expect(planFragments(spec, [250], [node()], new Date(ist(7, 0).getTime() - 40_000))).not.toBeNull();
    expect(planFragments(spec, [250], [], now)).toBeNull();
  });

  it("quotes a round time with slack after the planned finish", () => {
    const d = quotedDeadline(ist(23, 2), 30 * 60);
    expect(d.getTime() % (15 * 60_000)).toBe(0);
    // 30 min × 1.5 + 10 min = 55 min → 23:57 → 00:00.
    expect(d).toEqual(ist(24, 0));
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 * 3600 }), (s) => {
        const deadline = quotedDeadline(now, s).getTime();
        return deadline >= now.getTime() + s * 1500 + 600_000 && deadline - (now.getTime() + s * 1500 + 600_000) < 15 * 60_000 + 1000;
      }),
    );
  });

  it("estimates time from the benchmark: twice the score, half the per-item time", () => {
    const at1000 = estimateSeconds(spec, 250, 1000) - spec.cost.overheadSec;
    const at2000 = estimateSeconds(spec, 250, 2000) - spec.cost.overheadSec;
    expect(at2000).toBe(Math.ceil(at1000 / 2));
  });
});

describe("leases and backup copies", () => {
  it("gives a node twice the expected time plus two minutes, capped", () => {
    expect(leaseSeconds(60)).toBe(240);
    expect(leaseSeconds(1e9)).toBe(MAX_LEASE_SEC);
  });

  it("starts a backup only when a piece is slow AND the deadline is near", () => {
    const confirmedAt = ist(23, 0);
    const deadline = ist(25, 0);
    const startedAt = ist(24, 30);
    const base = { confirmedAt, deadline, startedAt, expectedSec: 600 };
    expect(needsBackup({ ...base, now: ist(24, 50) })).toBe(true);
    expect(needsBackup({ ...base, now: ist(24, 38) })).toBe(false); // not slow yet
    expect(needsBackup({ ...base, startedAt: ist(23, 0), now: ist(23, 30) })).toBe(false); // slow but plenty of time
    expect(needsBackup({ ...base, now: ist(25, 1) })).toBe(false); // already past the deadline
  });
});

describe("owner pay per fragment", () => {
  it("pays the owner's own rate plus their own electricity, rounded up", () => {
    const pay = fragmentPay(node({ measuredWatts: 350 }), 3600);
    expect(pay.electricityPaise).toBe(powerCostPerHourPaise(350, 900));
    expect(pay.ownerPayPaise).toBe(2500);
  });

  it("never pays less than the power cost, for any node", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 24 * 3600 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (s, watts, tariff, rate) => {
          const pay = fragmentPay(node({ measuredWatts: watts, tariffPaisePerKwh: tariff, ownerRatePaisePerHr: rate }), s);
          return pay.electricityPaise * 3_600_000 >= watts * tariff * s;
        },
      ),
    );
  });

  it("the quote always covers what every owner is paid (per-fragment rounding)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 4 * 3600 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 0, max: 10_000 })), {
          minLength: 1,
          maxLength: 40,
        }),
        (secs, refW, refT, refR, nodesRaw) => {
          const quote = priceJob(
            secs.map((s) => ({ gpuSeconds: s, watts: refW, tariffPaisePerKwh: refT, ownerRatePaisePerHr: refR })),
            { roundPerFragment: true },
          );
          const cap = { maxWattTariff: refW * refT, maxOwnerRate: refR };
          // Each fragment goes to some node within the cap.
          let paid = 0;
          secs.forEach((s, i) => {
            const [w, t, r] = nodesRaw[i % nodesRaw.length]!;
            const n = node({ measuredWatts: w, tariffPaisePerKwh: t, ownerRatePaisePerHr: r });
            if (!withinCap(n, cap)) return;
            const p = fragmentPay(n, s);
            paid += p.electricityPaise + p.ownerPayPaise;
          });
          return paid <= quote.ownerReceivesPaise && quote.ownerReceivesPaise <= quote.totalPaise;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("per-fragment rounding is the sum of single-fragment prices, and never cheaper than job rounding", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 36_000 }), { minLength: 1, maxLength: 30 }), (secs) => {
        const f = secs.map((s) => ({ gpuSeconds: s, watts: 350, tariffPaisePerKwh: 900, ownerRatePaisePerHr: 2500 }));
        const per = priceJob(f, { roundPerFragment: true });
        const sum = f.map((x) => priceJob([x]).ownerReceivesPaise).reduce((a, b) => a + b, 0);
        return per.ownerReceivesPaise === sum && per.totalPaise >= priceJob(f).totalPaise;
      }),
    );
  });
});

describe("measured watts", () => {
  it("replace the class default and move as a rolling average", () => {
    expect(nextMeasuredWatts(null, 300)).toBe(300);
    expect(nextMeasuredWatts(300, 400)).toBe(320);
    let w: number | null = null;
    for (let i = 0; i < 50; i++) w = nextMeasuredWatts(w, 410);
    expect(w).toBe(410);
  });
});
