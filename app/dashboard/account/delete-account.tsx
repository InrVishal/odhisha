"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { callApi } from "@/components/dashboard/api";
import { inputClass } from "@/components/dashboard/ui";

export function DeleteAccount() {
  const id = useId();
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await callApi("DELETE", "/api/account", { confirm: typed });
    if (!res.ok) {
      setPending(false);
      setError(res.error ?? "Couldn't delete the account.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
      <label htmlFor={id} className="block text-sm text-lavender">
        Type DELETE to confirm
      </label>
      <input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className={inputClass} />
      <div>
        <button
          type="submit"
          disabled={pending || typed !== "DELETE"}
          className="rounded border border-danger px-4 py-2 font-semibold text-danger hover:bg-danger hover:text-deep disabled:opacity-60"
        >
          {pending ? "Deleting..." : "Delete my account"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="rounded border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
