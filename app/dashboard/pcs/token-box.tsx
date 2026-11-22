"use client";

import { useState } from "react";
import { secondaryButtonClass } from "@/components/dashboard/ui";

/** A one-time token with the commands to use it. Never stored in the page after it's dismissed. */
export function TokenBox({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div role="status" className="mt-4 rounded border border-orange p-4">
      <p className="font-semibold text-lavender">This PC&apos;s token. It&apos;s shown once, so copy it now.</p>
      <p className="mt-2 rounded bg-night p-3 font-mono text-sm break-all text-lavender">{token}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" onClick={() => void copy()} className={secondaryButtonClass}>
          {copied ? "Copied" : "Copy token"}
        </button>
        <button type="button" onClick={onDone} className={secondaryButtonClass}>
          I&apos;ve saved it
        </button>
      </div>
      <p className="mt-4 text-sm text-mist">On that PC, with Docker Desktop running, open PowerShell and run:</p>
      <pre className="mt-2 overflow-x-auto rounded bg-night p-3 text-xs text-lavender">
        {`pipx install "git+https://github.com/InrVishal/odhisha.git#subdirectory=agent"
nightshift-agent login -          # paste the token, then press Enter
nightshift-agent start --no-gpu   # drop --no-gpu on a PC with an NVIDIA GPU`}
      </pre>
      <p className="mt-2 text-xs text-mist">
        Anyone with this token can take work as this PC. If it leaks, use &quot;New token&quot; below and the old one stops working.
      </p>
    </div>
  );
}
