"use client";

import { useActionState, useId } from "react";
import { buttonClass, inputClass } from "@/components/dashboard/ui";
import { submitAdminCodeAction, type CodeState } from "./actions";

export function CodeForm({ label }: { label: string }) {
  const id = useId();
  const [state, action, pending] = useActionState<CodeState, FormData>(submitAdminCodeAction, {});
  return (
    <form action={action} className="mt-4 flex max-w-md flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm text-lavender">
          {label}
        </label>
        <input
          id={id}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          className={`${inputClass} w-40 font-mono tracking-widest`}
        />
      </div>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Checking..." : "Continue"}
      </button>
      {state.error ? (
        <p role="alert" className="w-full rounded border border-danger p-3 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
