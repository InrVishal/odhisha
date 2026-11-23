import type { Metadata } from "next";
import { NODE_STATUS, rupees, UNAVAILABLE, when, windowText } from "@/components/dashboard/format";
import { Badge, Card, Empty, PageTitle } from "@/components/dashboard/ui";
import { CLASS_SPECS, NODE_CLASSES } from "@/lib/coordinator/classes";
import { listNodes } from "@/lib/coordinator/nodes";
import { pageContext } from "../data";
import { NodeControls } from "./node-controls";
import { RegisterPc } from "./register-pc";

export const metadata: Metadata = { title: "Your PCs" };

export default async function PcsPage() {
  const { user, db, now } = await pageContext();
  const list = await listNodes({ db, ownerId: user.id, now });
  const classes = NODE_CLASSES.map((c) => ({ value: c, label: CLASS_SPECS[c].label }));

  return (
    <>
      <PageTitle
        title="Your PCs"
        intro="Each PC runs the NightShift agent. It asks us for work during its night window, runs each piece in a locked container, and reports its power draw."
      />

      <div className="space-y-6">
        <RegisterPc classes={classes} />

        {list.length === 0 ? (
          <Empty>No PCs yet. Add one above, then install the agent on it.</Empty>
        ) : (
          list.map((n) => (
            <Card key={n.id} title={n.name} id={`pc-${n.id}`}>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge tone={n.available ? "good" : n.status === "quarantined" ? "bad" : "neutral"}>
                  {n.available ? "Taking work" : NODE_STATUS[n.status]}
                </Badge>
                {!n.available && n.unavailableReason && n.status === "online" ? (
                  <span className="text-sm text-mist">Not taking work: {UNAVAILABLE[n.unavailableReason] ?? n.unavailableReason}</span>
                ) : null}
              </div>
              {n.status === "quarantined" ? (
                <p className="mb-4 rounded border border-danger p-3 text-sm text-danger">
                  This PC is paused by NightShift: its results didn&apos;t match other PCs&apos; when we re-ran its pieces, so its
                  trust score fell below 200. It gets no work until we look into it. Pay for pieces that failed a check was
                  taken back; everything else it earned stays.
                </p>
              ) : null}
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <Item label="Kind" value={`${CLASS_SPECS[n.gpuClass].label}${n.gpuModel ? ` (${n.gpuModel})` : ""}`} />
                <Item
                  label="Speed, measured by NightShift"
                  value={n.benchmarkScore === null ? "Not measured yet (needs 3 checks)" : `${n.benchmarkScore} (RTX 3060 = 1000)`}
                />
                {n.reportedBenchmark !== null ? <Item label="Speed the PC reports" value={`${n.reportedBenchmark} (shown only, not used)`} /> : null}
                <Item
                  label="Power draw"
                  value={n.measuredWatts === null ? `${n.defaultWatts} W (class default)` : `${n.measuredWatts} W${n.wattsEstimated ? " (estimated, CPU mode)" : " (measured)"}`}
                />
                <Item label="Trust score" value={`${n.trustScore} / 1000`} />
                <Item label="Checks" value={`${n.checksPassed} passed, ${n.checksFailed} failed`} />
                <Item
                  label="Share of its pieces we re-run"
                  value={`${Math.round(n.checkRate * 100)}%${n.piecesDone < 20 ? ` (new PC: ${n.piecesDone} of its first 20 pieces done)` : ""}`}
                />
                <Item label="Earns" value={n.earnsCredits ? "Time-Bank credits (electricity still paid in rupees)" : "Rupees"} />
                <Item label="Night window" value={`${windowText(n.nightWindowStartMin, n.nightWindowEndMin)} (${n.timezone})`} />
                <Item label="Your rate" value={`${rupees(n.ownerRatePaisePerHr)} per hour`} />
                <Item label="Your electricity tariff" value={`${rupees(n.tariffPaisePerKwh)} per kWh`} />
                <Item label="Last heartbeat" value={when(n.lastSeenAt)} />
              </dl>
              <p className="mt-3 font-mono text-xs text-mist">PC id: {n.id}</p>
              <NodeControls node={n} />
            </Card>
          ))
        )}
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-mist">{label}</dt>
      <dd className="text-lavender">{value}</dd>
    </div>
  );
}
