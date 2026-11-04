import Link from "next/link";
import { headers } from "next/headers";
import { count } from "drizzle-orm";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { RegisterForm } from "@/components/RegisterForm";
import { FinishSetupForm } from "@/components/FinishSetupForm";

export const dynamic = "force-dynamic";

/** One-time owner setup. Closed for good as soon as a workspace exists. */
export default async function Setup() {
  const [{ n }] = await db.select({ n: count() }).from(schema.workspace);
  const owner = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const configured = Boolean(owner && process.env.SETUP_TOKEN);
  const session = n === 0 && configured ? await auth.api.getSession({ headers: await headers() }) : null;
  const isOwnerSignedIn = Boolean(session && session.user.email.toLowerCase() === owner);

  return (
    <div className="authwrap">
      {n === 0 && configured ? (
        isOwnerSignedIn ? <FinishSetupForm /> : <RegisterForm kind="setup" />
      ) : (
        <div className="authcard glass">
          <h1 style={{ fontSize: 22 }}>Setup is closed</h1>
          <p className="sub">{n > 0 ? "This workspace is already set up." : "Setup is not available yet."}</p>
          <Link className="btn" href="/login" style={{ textAlign: "center", display: "grid", alignItems: "center" }}>Go to sign in</Link>
        </div>
      )}
    </div>
  );
}
