import Link from "next/link";

// Auth.js sends errors here. We show one plain message and never echo the
// error code's internals back to the page.
export default function AuthErrorPage() {
  return (
    <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-4 py-24">
      <h1 className="text-2xl font-semibold">That didn&apos;t work</h1>
      <p>The link may have expired or already been used.</p>
      <p>
        <Link className="text-orange underline" href="/signin">
          Get a new login link
        </Link>
      </p>
    </main>
  );
}
