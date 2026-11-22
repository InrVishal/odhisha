"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { callApi } from "@/components/dashboard/api";
import { buttonClass, Card, inputClass } from "@/components/dashboard/ui";
import { TokenBox } from "./token-box";

export function RegisterPc({ classes }: { classes: Array<{ value: string; label: string }> }) {
  const router = useRouter();
  const ids = useId();
  const [name, setName] = useState("");
  const [gpuClass, setGpuClass] = useState("cpu");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await callApi<{ token: string }>("POST", "/api/nodes", { name: name.trim(), gpuClass });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? "Couldn't add the PC.");
      return;
    }
    setToken(res.data.token);
    setName("");
    router.refresh();
  }

  return (
    <Card title="Add a PC">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-4" noValidate>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-name`} className="text-sm font-medium text-lavender">
            Name
          </label>
          <input
            id={`${ids}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            required
            placeholder="For example, Hostel laptop"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-class`} className="text-sm font-medium text-lavender">
            Kind
          </label>
          <select id={`${ids}-class`} value={gpuClass} onChange={(e) => setGpuClass(e.target.value)} className={inputClass}>
            {classes.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending || !name.trim()} className={buttonClass}>
          {pending ? "Adding..." : "Add PC"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 rounded border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {token ? <TokenBox token={token} onDone={() => setToken(null)} /> : null}
    </Card>
  );
}
