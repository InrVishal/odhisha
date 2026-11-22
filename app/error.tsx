"use client";

// Generic error page. Details go to the server log (and Sentry from phase 8),
// never to the browser.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-4 py-24">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p>It&apos;s on our side. Try again, and if it keeps happening, come back in a few minutes.</p>
      <button type="button" onClick={reset} className="rounded border border-zinc-400 px-4 py-2">
        Try again
      </button>
    </main>
  );
}
