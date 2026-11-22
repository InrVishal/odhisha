import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-4 py-24">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p>
        <Link className="text-orange underline" href="/">
          Go to the home page
        </Link>
      </p>
    </main>
  );
}
