import Link from "next/link";
import { count } from "drizzle-orm";
import { db, schema } from "@/db";
import { RegisterForm } from "@/components/RegisterForm";

export const dynamic = "force-dynamic";

/** One-time owner setup. Closed for good as soon as a workspace exists. */
export default async function Setup() {
  const [{ n }] = await db.select({ n: count() }).from(schema.workspace);
  const configured = Boolean(process.env.OWNER_EMAIL && process.env.SETUP_TOKEN);
  return (
    <div className="authwrap">
      {n === 0 && configured ? <RegisterForm kind="setup" /> : (
        <div className="authcard glass">
          <h1 style={{ fontSize: 22 }}>Setup is closed</h1>
          <p className="sub">{n > 0 ? "This workspace is already set up." : "Setup is not available yet."}</p>
          <Link className="btn" href="/login" style={{ textAlign: "center", display: "grid", alignItems: "center" }}>Go to sign in</Link>
        </div>
      )}
    </div>
  );
}
