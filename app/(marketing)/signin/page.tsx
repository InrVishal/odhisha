import { redirect } from "next/navigation";
import { googleLoginAvailable } from "@/lib/auth";
import { currentUser } from "@/lib/auth/guards";
import { signInWithGoogle } from "./actions";
import { SignInForm } from "./signin-form";

const ERRORS: Record<string, string> = {
  RateLimited: "Too many login links sent to that address. Wait 15 minutes and try again.",
  AccessDenied: "We couldn't log you in with that account.",
  Verification: "That link has expired or was already used. Ask for a new one.",
};

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  if (await currentUser()) redirect("/dashboard");
  const { error } = await searchParams;
  const message = typeof error === "string" ? (ERRORS[error] ?? "Something went wrong. Try again.") : null;
  // Hidden on Vercel previews: Google has no wildcard redirect URIs.
  const googleEnabled = await googleLoginAvailable();

  return (
    <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-24">
      <h1 className="text-2xl font-semibold">Log in to NightShift</h1>
      <p>We email you a link. You click it. No password to remember.</p>
      {message ? (
        <p role="alert" className="rounded border border-danger p-3 text-sm">
          {message}
        </p>
      ) : null}
      <SignInForm />
      {googleEnabled ? (
        <form action={signInWithGoogle}>
          <button type="submit" className="w-full rounded border border-mist/60 px-4 py-2 font-medium">
            Continue with Google
          </button>
        </form>
      ) : null}
    </main>
  );
}
