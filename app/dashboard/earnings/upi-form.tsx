"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { callApi } from "@/components/dashboard/api";
import { buttonClass, inputClass } from "@/components/dashboard/ui";

/** Links (or changes) the payout UPI ID. */
export function UpiForm({ linked }: { linked: boolean }) {
  const router = useRouter();
  const id = useId();
  const [upi, setUpi] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setSaved(null);
    const res = await callApi<{ upiMasked: string }>("POST", "/api/account/upi", { upiId: upi });
    setPending(false);
    if (!res.ok) return setError(res.error ?? "That didn't work.");
    setSaved(`Linked ${res.data?.upiMasked ?? ""}.`);
    setUpi("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-4 flex max-w-xl flex-wrap items-end gap-3" noValidate>
      <div className="flex min-w-60 flex-1 flex-col gap-1">
        <label htmlFor={id} className="text-sm text-lavender">
          {linked ? "Change UPI ID" : "UPI ID"}
        </label>
        <input id={id} value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" autoComplete="off" className={inputClass} />
      </div>
      <button type="submit" disabled={pending || upi.trim().length < 3} className={buttonClass}>
        {pending ? "Saving..." : linked ? "Change" : "Link UPI ID"}
      </button>
      {error ? (
        <p role="alert" className="w-full rounded border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="w-full text-sm text-lavender">
          {saved}
        </p>
      ) : null}
    </form>
  );
}
