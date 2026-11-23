"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi } from "@/components/dashboard/api";
import { buttonClass, secondaryButtonClass } from "@/components/dashboard/ui";

export function QuoteActions({ jobId, credits }: { jobId: string; credits?: { cost: string; enough: boolean; available: string } }) {
  const router = useRouter();
  const [pending, setPending] = useState<"confirm" | "credits" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "confirm" | "credits" | "cancel") {
    setPending(kind);
    setError(null);
    const res =
      kind === "cancel"
        ? await callApi("POST", `/api/jobs/${jobId}/cancel`)
        : await callApi("POST", `/api/jobs/${jobId}/confirm`, { payWith: kind === "credits" ? "credits" : "money" });
    setPending(null);
    if (!res.ok) setError(res.error ?? "That didn't work.");
    router.refresh();
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => void act("confirm")} disabled={pending !== null} className={buttonClass}>
          {pending === "confirm" ? "Confirming..." : "Confirm and pay (demo)"}
        </button>
        {credits ? (
          <button type="button" onClick={() => void act("credits")} disabled={pending !== null || !credits.enough} className={secondaryButtonClass}>
            {pending === "credits" ? "Confirming..." : `Pay with Time-Bank credits (${credits.cost})`}
          </button>
        ) : null}
        <button type="button" onClick={() => void act("cancel")} disabled={pending !== null} className={secondaryButtonClass}>
          {pending === "cancel" ? "Cancelling..." : "Cancel quote"}
        </button>
      </div>
      {credits && !credits.enough ? (
        <p className="mt-3 text-sm text-mist">
          Paying with credits needs {credits.cost} of verified credits. You have {credits.available}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 rounded border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
