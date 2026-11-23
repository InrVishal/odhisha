import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JOB_STATUS, NODE_STATUS, rupees, shortId, when } from "@/components/dashboard/format";
import { Badge, Card, Empty, PageTitle, Stat, TableWrap, Td, Th } from "@/components/dashboard/ui";
import { adminAudit, adminJobs, adminLedger, adminNodes, adminTotals } from "@/lib/admin";
import { AuthzError, requireAdmin } from "@/lib/auth/guards";
import { CLASS_SPECS } from "@/lib/coordinator/classes";
import { WORKLOADS } from "@/lib/coordinator/workloads";
import { pageContext } from "../data";
import { ReleaseButton } from "./release-button";

export const metadata: Metadata = { title: "Admin" };

/**
 * Read-only admin panel. The role is re-read from the database on every
 * request (requireAdmin) and is only ever set in the database. Anyone else
 * gets a plain 404, so the page doesn't even confirm it exists.
 */
export default async function AdminPage() {
  const { db } = await pageContext();
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthzError) notFound();
    throw err;
  }
  const [totals, nodeRows, quarantined, jobRows, ledger, auditRows] = await Promise.all([
    adminTotals(db),
    adminNodes(db),
    adminNodes(db, true),
    adminJobs(db),
    adminLedger(db),
    adminAudit(db),
  ]);

  return (
    <>
      <PageTitle
        title="Admin"
        intro="The newest 100 rows of each list. Account ids only: no emails or IP data here. The one action is releasing a quarantined PC."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Accounts" value={totals.users} />
        <Stat label="PCs" value={totals.nodes} />
        <Stat label="Jobs" value={totals.jobs} />
        <Stat label="Buyers paid (net)" value={rupees(totals.buyerNetPaise)} />
        <Stat label="Owners earned (net)" value={rupees(totals.ownerNetPaise)} />
      </div>

      <div className="mt-8 space-y-6">
        <Card title="Quarantine list">
          {quarantined.length === 0 ? (
            <Empty>No PCs are quarantined.</Empty>
          ) : (
            <TableWrap label="Quarantined PCs">
              <thead>
                <tr>
                  <Th>PC</Th>
                  <Th>Owner</Th>
                  <Th right>Trust</Th>
                  <Th right>Checks failed</Th>
                  <Th>Quarantined</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody>
                {quarantined.map((n) => (
                  <tr key={n.id}>
                    <Td>{n.name}</Td>
                    <Td mono>{shortId(n.ownerId)}</Td>
                    <Td right>{n.trustScore}</Td>
                    <Td right>{n.checksFailed}</Td>
                    <Td>{when(n.quarantinedAt)}</Td>
                    <Td>
                      <ReleaseButton nodeId={n.id} name={n.name} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="PCs">
          {nodeRows.length === 0 ? (
            <Empty>No PCs yet.</Empty>
          ) : (
            <TableWrap label="All PCs">
              <thead>
                <tr>
                  <Th>PC</Th>
                  <Th>Owner</Th>
                  <Th>Kind</Th>
                  <Th>Status</Th>
                  <Th right>Benchmark</Th>
                  <Th right>Watts</Th>
                  <Th right>Trust</Th>
                  <Th right>Checks passed / failed</Th>
                  <Th>Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {nodeRows.map((n) => (
                  <tr key={n.id}>
                    <Td>
                      {n.name}
                      <br />
                      <span className="font-mono text-xs">{shortId(n.id)}</span>
                    </Td>
                    <Td mono>{shortId(n.ownerId)}</Td>
                    <Td>{CLASS_SPECS[n.gpuClass].label}</Td>
                    <Td>
                      <Badge tone={n.status === "online" ? "good" : n.status === "quarantined" ? "bad" : "neutral"}>
                        {NODE_STATUS[n.status]}
                        {n.paused ? ", paused" : ""}
                      </Badge>
                    </Td>
                    <Td right>{n.benchmarkScore ?? "-"}</Td>
                    <Td right>{n.measuredWatts === null ? "-" : `${n.measuredWatts}${n.wattsEstimated ? " est." : ""}`}</Td>
                    <Td right>{n.trustScore}</Td>
                    <Td right>
                      {n.checksPassed} / {n.checksFailed}
                    </Td>
                    <Td>{when(n.lastSeenAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="Jobs">
          {jobRows.length === 0 ? (
            <Empty>No jobs yet.</Empty>
          ) : (
            <TableWrap label="All jobs">
              <thead>
                <tr>
                  <Th>Job</Th>
                  <Th>Buyer</Th>
                  <Th>Work</Th>
                  <Th>Status</Th>
                  <Th right>Price</Th>
                  <Th>Deadline</Th>
                </tr>
              </thead>
              <tbody>
                {jobRows.map((j) => (
                  <tr key={j.id}>
                    <Td mono>{shortId(j.id)}</Td>
                    <Td mono>{shortId(j.buyerId)}</Td>
                    <Td>
                      {WORKLOADS[j.workloadType].label}, {j.itemCount} items in {j.fragmentCount} pieces
                    </Td>
                    <Td>{JOB_STATUS[j.status]}</Td>
                    <Td right>{rupees(j.pricePaise)}</Td>
                    <Td>{when(j.deadlineAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="Ledger">
          {ledger.length === 0 ? (
            <Empty>No ledger entries yet.</Empty>
          ) : (
            <TableWrap label="Ledger entries">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Ledger</Th>
                  <Th>Account</Th>
                  <Th>Type</Th>
                  <Th>Job</Th>
                  <Th right>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => (
                  <tr key={`${r.ledger}-${r.id}`}>
                    <Td>{when(r.at)}</Td>
                    <Td>{r.ledger}</Td>
                    <Td mono>{shortId(r.accountId)}</Td>
                    <Td>{r.type}</Td>
                    <Td mono>{r.jobId ? shortId(r.jobId) : "-"}</Td>
                    <Td right>{r.unit === "paise" ? rupees(r.amount) : `${r.amount} std GPU-s`}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="Audit log">
          {auditRows.length === 0 ? (
            <Empty>Nothing logged yet.</Empty>
          ) : (
            <TableWrap label="Audit log entries">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {auditRows.map((a) => (
                  <tr key={a.id}>
                    <Td>{when(a.at)}</Td>
                    <Td mono>
                      {a.actorType}
                      {a.actorId ? ` ${shortId(a.actorId)}` : ""}
                    </Td>
                    <Td>{a.action}</Td>
                    <Td mono>{a.targetType ? `${a.targetType} ${a.targetId ? shortId(a.targetId) : ""}` : "-"}</Td>
                    <Td mono>{a.meta ? JSON.stringify(a.meta).slice(0, 120) : "-"}</Td>
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
