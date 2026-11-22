import Link from "next/link";

// Placeholder until phase 2 builds the real site and copy.
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-4 py-24">
      <h1 className="text-3xl font-semibold">NightShift</h1>
      <p>We are still building this site. The full pages come next.</p>
      <p>
        <Link className="underline" href="/signin">
          Log in
        </Link>
      </p>
    </main>
  );
}
