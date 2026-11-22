import type { Metadata } from "next";
import { PageTitle } from "@/components/dashboard/ui";
import { CLASS_SPECS, NODE_CLASSES } from "@/lib/coordinator/classes";
import { WORKLOAD_TYPES, WORKLOADS } from "@/lib/coordinator/workloads";
import { pageContext } from "../../data";
import { NewJobForm, type WorkloadOption } from "./new-job-form";

export const metadata: Metadata = { title: "New job" };

export default async function NewJobPage() {
  await pageContext();
  // Plain data for the client form. Only workloads with a pinned image can run.
  const workloads: WorkloadOption[] = WORKLOAD_TYPES.filter((t) => WORKLOADS[t].image).map((t) => ({
    type: t,
    label: WORKLOADS[t].label,
    itemKind: WORKLOADS[t].itemKind,
    maxItems: WORKLOADS[t].limits.maxItems,
    maxItemBytes: WORKLOADS[t].limits.maxItemBytes,
    maxTotalBytes: WORKLOADS[t].limits.maxTotalBytes,
  }));
  const classes = NODE_CLASSES.map((c) => ({ value: c, label: CLASS_SPECS[c].label }));

  return (
    <>
      <PageTitle
        title="New job"
        intro="Add your data and pick the kind of PC. You get a price and a finish time first. Nothing is charged until you confirm, and the quote is held for 10 minutes."
      />
      <NewJobForm workloads={workloads} classes={classes} />
    </>
  );
}
