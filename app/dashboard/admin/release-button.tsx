"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi } from "@/components/dashboard/api";
import { secondaryButtonClass } from "@/components/dashboard/ui";

export function ReleaseButton({ nodeId, name }: { nodeId: string; name: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function release() {
    if (!window.confirm(`Release ${name}? It can take work again, with trust just above the quarantine line.`)) return;
    setPending(true);
    setError(null);
    const res = await callApi("POST", `/api/admin/nodes/${nodeId}/release`);
    setPending(false);
    if (!res.ok) setError(res.error ?? "That didn't work.");
    router.refresh();
  }
  return (
    <>
      <button type="button" onClick={() => void release()} disabled={pending} className={`${secondaryButtonClass} text-xs`}>
        {pending ? "Releasing..." : "Release"}
      </button>
      {error ? (
        <span role="alert" className="ml-2 text-xs text-danger">
          {error}
        </span>
      ) : null}
    </>
  );
}
