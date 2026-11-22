"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { callApi } from "@/components/dashboard/api";
import { hhmm } from "@/components/dashboard/format";
import { buttonClass, inputClass, secondaryButtonClass } from "@/components/dashboard/ui";
import type { PublicNode } from "@/lib/coordinator/nodes";
import { TokenBox } from "./token-box";

const toMinutes = (v: string) => {
  const m = /^(\d\d):(\d\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Pause/resume, night window, rates, new token and remove for one PC. */
export function NodeControls({ node }: { node: PublicNode }) {
  const router = useRouter();
  const ids = useId();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [allDay, setAllDay] = useState(node.nightWindowStartMin === node.nightWindowEndMin);
  const [start, setStart] = useState(hhmm(node.nightWindowStartMin));
  const [end, setEnd] = useState(hhmm(node.nightWindowEndMin));
  const [rate, setRate] = useState((node.ownerRatePaisePerHr / 100).toString());
  const [tariff, setTariff] = useState((node.tariffPaisePerKwh / 100).toString());

  const removed = node.status === "revoked";

  async function run(kind: string, method: string, path: string, body?: unknown, done?: string) {
    setPending(kind);
    setError(null);
    setSaved(null);
    const res = await callApi<{ token?: string }>(method, path, body);
    setPending(null);
    if (!res.ok) {
      setError(res.error ?? "That didn't work.");
      return false;
    }
    if (res.data?.token) setToken(res.data.token);
    if (done) setSaved(done);
    router.refresh();
    return true;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const s = allDay ? 0 : toMinutes(start);
    const en = allDay ? 0 : toMinutes(end);
    const ratePaise = Math.round(Number(rate) * 100);
    const tariffPaise = Math.round(Number(tariff) * 100);
    if (s === null || en === null) return setError("Use times like 23:00.");
    if (!Number.isFinite(ratePaise) || ratePaise < 0) return setError("Your rate must be ₹0 or more.");
    if (!Number.isFinite(tariffPaise) || tariffPaise < 1) return setError("Your tariff must be more than ₹0.");
    if (
      await run("save", "PATCH", `/api/nodes/${node.id}`, {
        nightWindowStartMin: s,
        nightWindowEndMin: en,
        ownerRatePaisePerHr: ratePaise,
        tariffPaisePerKwh: tariffPaise,
      }, "Saved.")
    ) {
      setEditing(false);
    }
  }

  return (
    <div className="mt-4 border-t border-navy pt-4">
      <div className="flex flex-wrap gap-3">
        {!removed ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void run("pause", "PATCH", `/api/nodes/${node.id}`, { paused: !node.paused }, node.paused ? "Resumed." : "Paused. A piece already running finishes first.")}
            className={node.paused ? buttonClass : secondaryButtonClass}
          >
            {node.paused ? "Resume" : "Pause"}
          </button>
        ) : null}
        <button type="button" disabled={pending !== null} onClick={() => setEditing((v) => !v)} className={secondaryButtonClass} aria-expanded={editing}>
          Hours and rates
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => {
            if (window.confirm("Make a new token? The current one stops working, so the agent must log in again.")) {
              void run("token", "POST", `/api/nodes/${node.id}/token`);
            }
          }}
          className={secondaryButtonClass}
        >
          New token
        </button>
        {!removed ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => {
              if (window.confirm(`Remove ${node.name}? Its agent is locked out straight away. Its earnings stay in your account.`)) {
                void run("remove", "DELETE", `/api/nodes/${node.id}/token`, undefined, "Removed. Its agent can't take work any more.");
              }
            }}
            className={secondaryButtonClass}
          >
            Remove
          </button>
        ) : null}
      </div>

      {editing ? (
        <form onSubmit={save} className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
          <label className="flex items-center gap-2 text-sm text-lavender sm:col-span-2">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            Take work all day (handy for a demo)
          </label>
          {!allDay ? (
            <>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-start`} className="text-sm text-lavender">Night window starts</label>
                <input id={`${ids}-start`} type="time" value={start} onChange={(e) => setStart(e.target.value)} className={inputClass} />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-end`} className="text-sm text-lavender">Night window ends</label>
                <input id={`${ids}-end`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={inputClass} />
              </div>
            </>
          ) : null}
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-rate`} className="text-sm text-lavender">Your rate (₹ per hour of work)</label>
            <input id={`${ids}-rate`} type="number" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={inputClass} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-tariff`} className="text-sm text-lavender">Your electricity tariff (₹ per kWh)</label>
            <input id={`${ids}-tariff`} type="number" min={0.01} step="0.01" value={tariff} onChange={(e) => setTariff(e.target.value)} className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={pending !== null} className={buttonClass}>
              {pending === "save" ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-3 text-sm text-lavender">
          {saved}
        </p>
      ) : null}
      {token ? <TokenBox token={token} onDone={() => setToken(null)} /> : null}
    </div>
  );
}
