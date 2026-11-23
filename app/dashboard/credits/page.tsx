import type { Metadata } from "next";
import Link from "next/link";
import { shortId, when } from "@/components/dashboard/format";
import { Card, Empty, PageTitle, Stat, TableWrap, Td, Th } from "@/components/dashboard/ui";
import { creditHistory, creditWallet } from "@/lib/credits";
import { formatCredits } from "@/lib/timebank";
import { pageContext } from "../data";

export const metadata: Metadata = { title: "Time-Bank" };

const TYPE: Record<string, string> = {
  earned: "Earned (pending until verified)",
  spent: "Spent on a job",
  refund: "Refunded",
  clawback: "Clawed back",
  expired: "Expired",
  reversal: "Reversed",
};

const hours = (sec: number) => (sec < 0 ? `−${formatCredits(-sec)}` : formatCredits(sec));

export default async function CreditsPage() {
  const { user, db, now } = await pageContext();
  const [wallet, history] = await Promise.all([creditWallet(db, user.id, now), creditHistory(db, user.id, 100)]);

  return (
    <>
      <PageTitle
        title="Time-Bank"
        intro="Credits your PCs earned by working for the network, to spend on jobs of your own. Demo mode: the wallet is simulated, like everything with money in it."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Available to spend" value={hours(wallet.availableSec)} note="Verified and not expired" />
        <Stat label="Waiting to be verified" value={hours(wallet.pendingSec)} />
        <Stat label="Expiring within 30 days" value={hours(wallet.expiringSoonSec)} />
        <Stat label="Clawed back so far" value={hours(wallet.clawedBackSec)} />
      </div>

      <div className="mt-8 space-y-6">
        <Card title="How credits work">
          <ul className="list-disc space-y-2 pl-5 text-sm text-mist">
            <li>
              Set a PC to earn credits on the <Link href="/dashboard/pcs">Your PCs</Link> page. Its pieces of buyers&apos; jobs then
              earn credits instead of pay for GPU time. Electricity is still paid back in rupees.
            </li>
            <li>One standard GPU-hour for every hour of verified work, on any GPU. Weighting by speed is switched off until our speed scores are calibrated.</li>
            <li>
              New credits wait until the work is verified: its check matched, or, for pieces that weren&apos;t picked for a check, a
              day has passed and the PC is in good standing.
            </li>
            <li>Credits are taken back if the work was wrong, its check couldn&apos;t be settled, or the PC was quarantined before the work was verified.</li>
            <li>Credits expire 6 months after they were earned. The oldest are spent first.</li>
            <li>Credits can&apos;t be cashed out, sold or given to anyone. You spend them on a job: pick &quot;Pay with Time-Bank credits&quot; on a quote.</li>
          </ul>
        </Card>

        <Card title="History">
          {history.length === 0 ? (
            <Empty>No credits yet.</Empty>
          ) : (
            <TableWrap label="Time-Bank history">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>What</Th>
                  <Th>Job</Th>
                  <Th right>Credit</Th>
                  <Th>Expires</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <Td>{when(r.at)}</Td>
                    <Td>{TYPE[r.type] ?? r.type}</Td>
                    <Td mono>{r.jobId ? shortId(r.jobId) : "-"}</Td>
                    <Td right>{hours(Number(r.seconds))}</Td>
                    <Td>{r.expiresAt ? when(r.expiresAt) : "-"}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}
