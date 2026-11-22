import type { Metadata } from "next";
import Link from "next/link";
import { JOB_STATUS, rupees, when } from "@/components/dashboard/format";
import { Badge, buttonClass, Empty, PageTitle, TableWrap, Td, Th } from "@/components/dashboard/ui";
import { CLASS_SPECS } from "@/lib/coordinator/classes";
import { listJobs } from "@/lib/coordinator/jobs";
import { WORKLOADS } from "@/lib/coordinator/workloads";
import { pageContext, tickQuietly } from "../data";
import { statusTone } from "./status";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsPage() {
  const { user, db } = await pageContext();
  await tickQuietly(db);
  const list = await listJobs({ db, buyerId: user.id });

  return (
    <>
      <PageTitle title="Your jobs" intro="Every job you've quoted or run, newest first. Open one to see its progress, results and invoice.">
        <Link href="/dashboard/jobs/new" className={buttonClass}>
          New job
        </Link>
      </PageTitle>

      {list.length === 0 ? (
        <Empty>
          <p>No jobs yet.</p>
          <p className="mt-2">
            <Link href="/dashboard/jobs/new">Get a quote for your first job</Link>
          </p>
        </Empty>
      ) : (
        <TableWrap label="Your jobs">
          <thead>
            <tr>
              <Th>Created</Th>
              <Th>Work</Th>
              <Th>Status</Th>
              <Th right>Pieces done</Th>
              <Th right>Price</Th>
              <Th right>You paid</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((j) => (
              <tr key={j.id}>
                <Td>
                  <Link href={`/dashboard/jobs/${j.id}`}>{when(j.confirmedAt ?? j.quoteExpiresAt)}</Link>
                </Td>
                <Td>
                  {WORKLOADS[j.workloadType].label}, {j.itemCount} items
                  <br />
                  <span className="text-xs">{CLASS_SPECS[j.gpuClass].label}</span>
                </Td>
                <Td>
                  <Badge tone={statusTone(j.status)}>{JOB_STATUS[j.status]}</Badge>
                </Td>
                <Td right>
                  {j.progress.fragmentsDone} / {j.progress.fragmentsTotal}
                </Td>
                <Td right>{rupees(j.pricePaise)}</Td>
                <Td right>{rupees(j.netChargedPaise)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </>
  );
}
