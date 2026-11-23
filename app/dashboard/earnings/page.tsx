import type { Metadata } from "next";
import Link from "next/link";
import { rupees, shortId, when } from "@/components/dashboard/format";
import { Card, Empty, PageTitle, Stat, TableWrap, Td, Th } from "@/components/dashboard/ui";
import { listNodes } from "@/lib/coordinator/nodes";
import { heldEarnings } from "@/lib/coordinator/verification";
import { creditWallet } from "@/lib/credits";
import { earningsByNode, ownerPieces } from "@/lib/dashboard";
import { getDbUser } from "@/lib/dashboard";
import { UpiForm } from "./upi-form";
import { ownerEarnings } from "@/lib/ledger";
import { formatCredits } from "@/lib/timebank";
import { pageContext } from "../data";

export const metadata: Metadata = { title: "Earnings" };

export default async function EarningsPage() {
  const { user, db, now } = await pageContext();
  const [totals, perNode, pieces, nodes, credits, held] = await Promise.all([
    ownerEarnings(db, user.id),
    earningsByNode(db, user.id),
    ownerPieces(db, user.id, 200),
    listNodes({ db, ownerId: user.id, now }),
    creditWallet(db, user.id, now),
    heldEarnings(db, user.id),
  ]);
  const me = await getDbUser(db, user.id);
  const names = new Map(nodes.map((n) => [n.id, n.name]));

  return (
    <>
      <PageTitle
        title="Earnings"
        intro="What your PCs have earned. Electricity is always its own line, paid on top of your rate. Demo mode: no real money moves yet."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pay for GPU time" value={rupees(totals.computePayPaise)} />
        <Stat label="Electricity paid back" value={rupees(totals.powerReimbursementPaise)} />
        <Stat label="Paid out" value={rupees(totals.paidOutPaise)} note="UPI payouts are simulated" />
        <Stat
          label="Balance"
          value={rupees(totals.balancePaise)}
          note={held > 0 ? `${rupees(held)} held until checks finish` : "Nothing held"}
        />
      </div>

      <div className="mt-8 space-y-6">
        <Card title="By PC">
          {perNode.length === 0 ? (
            <Empty>
              Nothing earned yet. <Link href="/dashboard/pcs">Add a PC</Link> and start the agent on it.
            </Empty>
          ) : (
            <TableWrap label="Earnings by PC">
              <thead>
                <tr>
                  <Th>PC</Th>
                  <Th right>Pieces done</Th>
                  <Th right>GPU time pay</Th>
                  <Th right>Electricity</Th>
                  <Th right>Total</Th>
                </tr>
              </thead>
              <tbody>
                {perNode.map((e) => (
                  <tr key={e.nodeId}>
                    <Td>{names.get(e.nodeId) ?? shortId(e.nodeId)}</Td>
                    <Td right>{e.pieces}</Td>
                    <Td right>{rupees(e.computePayPaise)}</Td>
                    <Td right>{rupees(e.powerReimbursementPaise)}</Td>
                    <Td right>{rupees(e.computePayPaise + e.powerReimbursementPaise)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="Payouts">
          <p className="text-sm text-mist">
            Payouts go to one UPI ID, and one UPI ID can belong to one account only. Demo mode: payouts are simulated, so
            nothing is sent to it.
          </p>
          <p className="mt-3 text-sm text-lavender">
            Payout UPI ID: <strong>{me?.upiMasked ?? "not linked yet"}</strong>
          </p>
          <UpiForm linked={Boolean(me?.upiMasked)} />
        </Card>

        <Card title="Time-Bank credits">
          <p className="text-2xl font-semibold text-lavender">{formatCredits(Math.max(credits.availableSec, 0))} available</p>
          <p className="mt-2 text-sm text-mist">
            {formatCredits(Math.max(credits.pendingSec, 0))} waiting to be verified. Credits can&apos;t be cashed out.{" "}
            <Link href="/dashboard/credits">Your Time-Bank wallet</Link>
          </p>
        </Card>

        <Card title="Pieces your PCs ran">
          {pieces.length === 0 ? (
            <Empty>No pieces yet.</Empty>
          ) : (
            <TableWrap label="Every piece your PCs ran">
              <thead>
                <tr>
                  <Th>Finished</Th>
                  <Th>PC</Th>
                  <Th>Job</Th>
                  <Th>Piece</Th>
                  <Th right>GPU time pay</Th>
                  <Th right>Electricity</Th>
                </tr>
              </thead>
              <tbody>
                {pieces.map((e) => (
                  <tr key={e.fragmentId}>
                    <Td>{when(e.at)}</Td>
                    <Td>{e.nodeId ? (names.get(e.nodeId) ?? shortId(e.nodeId)) : "-"}</Td>
                    <Td mono>{e.jobId ? shortId(e.jobId) : "-"}</Td>
                    <Td mono>{shortId(e.fragmentId)}</Td>
                    <Td right>{rupees(e.computePayPaise)}</Td>
                    <Td right>{rupees(e.powerReimbursementPaise)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          <p className="mt-3 text-xs text-mist">The newest 200. Your full history is in &quot;Download your data&quot; on the Account page.</p>
        </Card>
      </div>
    </>
  );
}
