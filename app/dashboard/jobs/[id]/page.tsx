import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { JOB_STATUS, rupees, shortId, when } from "@/components/dashboard/format";
import { Badge, buttonClass, Card, PageTitle, secondaryButtonClass, Stat } from "@/components/dashboard/ui";
import { CLASS_SPECS } from "@/lib/coordinator/classes";
import { getJob } from "@/lib/coordinator/jobs";
import { WORKLOADS } from "@/lib/coordinator/workloads";
import { orNotFound, pageContext, tickQuietly } from "../../data";
import { statusTone } from "../status";
import { QuoteActions } from "./quote-actions";

export const metadata: Metadata = { title: "Job" };

export default async function JobPage({ params }: PageProps<"/dashboard/jobs/[id]">) {
  const { id } = await params;
  const { user, db, now } = await pageContext();
  await tickQuietly(db);
  const job = await orNotFound(getJob({ db, buyerId: user.id }, id));
  const b = job.breakdown;
  const p = job.progress;
  // Shown with a native <progress>: the page CSP blocks inline style attributes.
  const pct = p.fragmentsTotal ? Math.round((p.fragmentsDone / p.fragmentsTotal) * 100) : 0;
  const quoteOpen = job.status === "quoted" && new Date(job.quoteExpiresAt) > now;
  const inProgress = job.status === "queued" || job.status === "running";

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/dashboard/jobs">← All jobs</Link>
      </p>
      <PageTitle
        title={`Job ${shortId(job.id)}`}
        intro={`${WORKLOADS[job.workloadType].label}: ${job.itemCount} items on ${CLASS_SPECS[job.gpuClass].label}s.`}
      >
        {job.resultsAvailable ? (
          <a href={`/api/jobs/${job.id}/results`} download className={buttonClass}>
            Download results (JSON)
          </a>
        ) : null}
        {job.confirmedAt ? (
          <a href={`/api/jobs/${job.id}/invoice`} download className={secondaryButtonClass}>
            Invoice (PDF)
          </a>
        ) : null}
      </PageTitle>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone={statusTone(job.status)}>{JOB_STATUS[job.status]}</Badge>
        {inProgress ? <AutoRefresh /> : null}
      </div>

      {job.status === "quoted" ? (
        <Card title={quoteOpen ? "Your quote" : "This quote has expired"}>
          {quoteOpen ? (
            <>
              <p className="text-mist">
                Price <strong className="text-lavender">{rupees(job.pricePaise)}</strong>, finished by{" "}
                <strong className="text-lavender">{when(job.deadlineAt)}</strong>. Held until {when(job.quoteExpiresAt)}. If we
                miss the finish time, you get the full price back automatically.
              </p>
              <QuoteActions jobId={job.id} />
            </>
          ) : (
            <p className="text-mist">
              Quotes are held for 10 minutes. <Link href="/dashboard/jobs/new">Get a new quote</Link>.
            </p>
          )}
        </Card>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Pieces done"
          value={`${p.fragmentsDone} / ${p.fragmentsTotal}`}
          note={<progress value={pct} max={100} aria-label="Pieces done" className="mt-2 h-2 w-full appearance-none overflow-hidden rounded [&::-moz-progress-bar]:bg-orange [&::-webkit-progress-bar]:bg-night [&::-webkit-progress-value]:bg-orange" />}
        />
        <Stat label="PCs working on it now" value={p.nodesWorking} />
        <Stat label="Finish by" value={when(job.deadlineAt)} note={job.completedAt ? `Finished ${when(job.completedAt)}` : undefined} />
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card title="Price breakdown">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="text-mist">Owners&apos; pay for GPU time</dt>
            <dd className="text-right text-lavender">{rupees(b.ownerPayPaise)}</dd>
            <dt className="text-mist">Electricity, paid to owners</dt>
            <dd className="text-right text-lavender">{rupees(b.electricityPaise)}</dd>
            <dt className="text-mist">Verification buffer</dt>
            <dd className="text-right text-lavender">{rupees(b.verificationBufferPaise)}</dd>
            <dt className="text-mist">NightShift fee</dt>
            <dd className="text-right text-lavender">{rupees(b.nightshiftFeePaise)}</dd>
            <dt className="border-t border-navy pt-2 font-semibold text-lavender">Price</dt>
            <dd className="border-t border-navy pt-2 text-right font-semibold text-lavender">{rupees(job.pricePaise)}</dd>
          </dl>
          <p className="mt-3 text-xs text-mist">Split into {b.fragments} {b.fragments === 1 ? "piece" : "pieces"}. Demo mode: the charge is simulated.</p>
        </Card>

        <Card title="Payments">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="text-mist">Charged</dt>
            <dd className="text-right text-lavender">{job.confirmedAt ? rupees(job.pricePaise) : rupees(0)}</dd>
            {job.refunded ? (
              <>
                <dt className="text-mist">Refund (deadline missed or job couldn&apos;t finish)</dt>
                <dd className="text-right text-lavender">{rupees(-job.pricePaise)}</dd>
              </>
            ) : null}
            <dt className="border-t border-navy pt-2 font-semibold text-lavender">You paid</dt>
            <dd className="border-t border-navy pt-2 text-right font-semibold text-lavender">{rupees(job.netChargedPaise)}</dd>
          </dl>
          {job.refunded ? (
            <p className="mt-3 text-sm text-mist">We didn&apos;t finish in time, so the whole price went back to you. You pay ₹0.</p>
          ) : null}
          {job.purged ? <p className="mt-3 text-sm text-mist">This job&apos;s data was deleted after 7 days, as promised.</p> : null}
          {job.resultsAvailable ? (
            <p className="mt-3 text-sm text-mist">Results are kept for 7 days after the finish time, then deleted.</p>
          ) : null}
        </Card>
      </div>
    </>
  );
}
