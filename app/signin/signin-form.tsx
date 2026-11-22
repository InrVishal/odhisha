"use client";

import { useActionState } from "react";
import { signInWithEmail, type SignInState } from "./actions";

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signInWithEmail, {});
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <label htmlFor="email" className="font-medium">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        aria-describedby={state.error ? "email-error" : undefined}
        aria-invalid={state.error ? true : undefined}
        className="rounded border border-zinc-400 bg-transparent px-3 py-2"
      />
      {state.error ? (
        <p id="email-error" role="alert" className="text-sm text-red-400">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-900 disabled:opacity-60">
        {pending ? "Sending..." : "Email me a login link"}
      </button>
    </form>
  );
}
