import { headers } from "next/headers";
import { Card, PageTitle, secondaryButtonClass } from "@/components/dashboard/ui";
import { totpSetupSecret } from "@/lib/admin-access";
import { audit } from "@/lib/audit";
import { ipHashSecret } from "@/lib/auth";
import { adminOr404 } from "@/lib/auth/guards";
import { getDb, getReadonlyDb } from "@/lib/db";
import { getKeys } from "@/lib/security/keys";
import { clientIp } from "@/lib/security/tokens";
import { logInAgainAction } from "./actions";
import { CodeForm } from "./code-form";
import { AdminPanel } from "./panel";

/**
 * Admin check 2 of 3: the page itself (the layout checked too, and every
 * action checks again). Non-admins never get here: they see a 404.
 */
export default async function AdminPage() {
  const access = await adminOr404();
  const db = await getDb();

  if (access.state === "stale_login") {
    return (
      <>
        <PageTitle title="Log in again" intro="Admin needs a login from the last 15 minutes, then a code from your authenticator app." />
        <form action={logInAgainAction}>
          <button type="submit" className={secondaryButtonClass}>
            Log out and log in again
          </button>
        </form>
      </>
    );
  }

  if (access.state === "setup") {
    const { secret, uri } = await totpSetupSecret(db, access, (await getKeys()).dataKey, new Date());
    return (
      <>
        <PageTitle
          title="Set up your authenticator"
          intro="Admin needs a second factor. Add NightShift to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis...), then enter the code it shows."
        />
        <Card title="Your setup key">
          <p className="text-sm text-mist">In the app, choose to enter a setup key, and type this in (time-based, 6 digits):</p>
          <p className="mt-3 break-all font-mono text-lg text-lavender" data-testid="totp-secret">
            {secret.match(/.{1,4}/g)?.join(" ")}
          </p>
          <p className="mt-3 text-sm text-mist">
            On a phone, this link opens the app: <a href={uri}>add NightShift to your authenticator</a>. Once it&apos;s confirmed, it can
            only be reset in the database, and the admins get an email about it.
          </p>
          <CodeForm label="Code from the app" />
        </Card>
      </>
    );
  }

  if (access.state === "code") {
    return (
      <>
        <PageTitle title="Enter your code" intro="Admin needs a code from your authenticator app on every login." />
        <Card>
          <CodeForm label="6-digit code" />
        </Card>
      </>
    );
  }

  // Every admin page view is logged.
  await audit(
    db,
    { actorId: access.userId, actorType: "admin", action: "admin.viewed", targetType: "page", targetId: "/admin", ip: clientIp(await headers()) },
    ipHashSecret(),
  );
  return <AdminPanel db={await getReadonlyDb()} />;
}
