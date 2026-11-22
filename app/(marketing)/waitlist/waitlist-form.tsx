"use client";

import { useActionState, useId } from "react";
import { waitlist as copy } from "@/content/site";
import { joinWaitlistAction, type WaitlistState } from "./actions";

type Interest = keyof typeof copy.interests;

export function WaitlistForm({ defaultInterest }: { defaultInterest: Interest }) {
  const id = useId();
  const [state, action, pending] = useActionState<WaitlistState, FormData>(joinWaitlistAction, { status: "idle" });
  const e = state.errors ?? {};

  if (state.status === "done") {
    return (
      <p role="status" className="rounded-lg border border-orange/60 bg-deep p-5 text-lavender">
        {copy.done}
      </p>
    );
  }

  return (
    <form action={action} noValidate className="flex flex-col gap-6 rounded-xl border border-navy bg-deep/80 p-6">
      {e.form ? (
        <p role="alert" className="text-danger">
          {e.form}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-email`} className="font-medium">
          {copy.emailLabel}
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          aria-invalid={e.email ? true : undefined}
          aria-describedby={e.email ? `${id}-email-err` : undefined}
          className="rounded border border-mist/60 bg-night px-3 py-2"
        />
        {e.email ? (
          <p id={`${id}-email-err`} className="text-sm text-danger">
            {e.email}
          </p>
        ) : null}
      </div>

      <fieldset aria-describedby={e.interest ? `${id}-interest-err` : undefined}>
        <legend className="font-medium">{copy.interestLabel}</legend>
        <div className="mt-2 flex flex-col gap-2">
          {(Object.keys(copy.interests) as Interest[]).map((k) => (
            <label key={k} className="flex items-center gap-3">
              <input type="radio" name="interest" value={k} defaultChecked={k === defaultInterest} className="h-4 w-4 accent-orange" />
              {copy.interests[k]}
            </label>
          ))}
        </div>
        {e.interest ? (
          <p id={`${id}-interest-err`} className="mt-1 text-sm text-danger">
            {e.interest}
          </p>
        ) : null}
      </fieldset>

      <div>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="consent"
            required
            aria-invalid={e.consent ? true : undefined}
            aria-describedby={e.consent ? `${id}-consent-err` : undefined}
            className="mt-1 h-4 w-4 accent-orange"
          />
          <span>{copy.consentLabel}</span>
        </label>
        {e.consent ? (
          <p id={`${id}-consent-err`} className="mt-1 text-sm text-danger">
            {e.consent}
          </p>
        ) : null}
      </div>

      <button type="submit" disabled={pending} className="self-start rounded bg-orange px-5 py-3 font-semibold text-deep hover:bg-lavender disabled:opacity-60">
        {pending ? copy.submitting : copy.submit}
      </button>
    </form>
  );
}
