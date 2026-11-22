import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { when } from "@/components/dashboard/format";
import { Card, PageTitle, secondaryButtonClass } from "@/components/dashboard/ui";
import { users } from "@/lib/db/schema";
import { logoutEverywhere } from "../actions";
import { pageContext } from "../data";
import { DeleteAccount } from "./delete-account";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const { user, db } = await pageContext();
  const [me] = await db.select({ email: users.email, createdAt: users.createdAt }).from(users).where(eq(users.id, user.id)).limit(1);

  return (
    <>
      <PageTitle title="Account" />
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Your account">
          <dl className="grid gap-y-3 text-sm">
            <div>
              <dt className="text-mist">Email</dt>
              <dd className="text-lavender">{me?.email ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-mist">Joined</dt>
              <dd className="text-lavender">{when(me?.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-mist">Account type</dt>
              <dd className="text-lavender">{user.role === "admin" ? "Admin" : "Regular"}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Log out everywhere">
          <p className="text-sm text-mist">
            Lost a phone, or used a cyber café PC? This ends every login on this account, on every device, including this one.
          </p>
          <form action={logoutEverywhere} className="mt-4">
            <button type="submit" className={secondaryButtonClass}>
              Log out of all devices
            </button>
          </form>
        </Card>
        <Card title="Download your data">
          <p className="text-sm text-mist">
            One JSON file with everything we store about you: your account, PCs, jobs, every ledger entry and your activity
            log. Job results are downloaded from each job.
          </p>
          <a href="/api/account/export" download className={`${secondaryButtonClass} mt-4`}>
            Download my data (JSON)
          </a>
        </Card>
        <Card title="Delete your account">
          <p className="text-sm text-mist">
            This removes your email and every login, locks out your PCs and deletes all stored job data now. Payment and
            earnings records stay so the books still add up, but only under a random account number with no email
            attached. This can&apos;t be undone.
          </p>
          <DeleteAccount />
        </Card>
      </div>
    </>
  );
}
