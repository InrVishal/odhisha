import Link from "next/link";
import { rupees } from "@/components/dashboard/format";
import { buttonClass, Card, PageTitle, secondaryButtonClass, Stat } from "@/components/dashboard/ui";
import { listJobs } from "@/lib/coordinator/jobs";
import { listNodes } from "@/lib/coordinator/nodes";
import { ownerEarnings } from "@/lib/ledger";
import { pageContext, tickQuietly } from "./data";

export default async function DashboardPage() {
  const { user, db, now } = await pageContext();
  await tickQuietly(db);
  const [jobList, nodeList, earnings] = await Promise.all([
    listJobs({ db, buyerId: user.id }),
    listNodes({ db, ownerId: user.id, now }),
    ownerEarnings(db, user.id),
  ]);
  const active = jobList.filter((j) => j.status === "queued" || j.status === "running").length;
  const finished = jobList.filter((j) => j.status === "completed").length;
  const working = nodeList.filter((n) => n.available).length;

  return (
    <>
      <PageTitle
        title="Your dashboard"
        intro="Run AI jobs on other people's idle PCs, or let your own PC take work at night. One account does both."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Jobs running" value={active} note={`${finished} finished so far`} />
        <Stat label="Your PCs taking work" value={`${working} of ${nodeList.length}`} />
        <Stat label="Earned (compute)" value={rupees(earnings.computePayPaise)} />
        <Stat label="Electricity paid to you" value={rupees(earnings.powerReimbursementPaise)} note="Shown separately, always" />
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Card title="Run a job">
          <p className="text-mist">
            Send a batch of texts to embed, or images to caption or resize. You see the full price and the finish time before
            you confirm. If we miss the time, you get the whole price back.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/dashboard/jobs/new" className={buttonClass}>
              New job
            </Link>
            <Link href="/dashboard/jobs" className={secondaryButtonClass}>
              Your jobs
            </Link>
          </div>
        </Card>
        <Card title="Let your PC earn">
          <p className="text-mist">
            Add a PC, install the NightShift agent on it, and it takes work during the hours you choose. You&apos;re paid your
            rate plus the electricity it uses.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/dashboard/pcs" className={buttonClass}>
              Your PCs
            </Link>
            <Link href="/dashboard/earnings" className={secondaryButtonClass}>
              Earnings
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
