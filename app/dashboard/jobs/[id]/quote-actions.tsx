"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi } from "@/components/dashboard/api";
import { buttonClass, secondaryButtonClass } from "@/components/dashboard/ui";

export function QuoteActions({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "confirm" | "cancel") {
    setPending(kind);
    setError(null);
    const res = await callApi("POST", `/api/jobs/${jobId}/${kind}`);
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
        <button type="button" onClick={() => void act("cancel")} disabled={pending !== null} className={secondaryButtonClass}>
          {pending === "cancel" ? "Cancelling..." : "Cancel quote"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 rounded border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
