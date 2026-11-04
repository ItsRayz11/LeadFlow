import Link from "next/link";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { sha256 } from "@/lib/tokens";
import { RegisterForm } from "@/components/RegisterForm";

export const dynamic = "force-dynamic";

export default async function Accept({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const [inv] = token
    ? await db.select().from(schema.invite).where(and(eq(schema.invite.tokenHash, sha256(token)), isNull(schema.invite.acceptedAt), isNull(schema.invite.revokedAt), gt(schema.invite.expiresAt, new Date()))).limit(1)
    : [];
  return (
    <div className="authwrap">
      {inv ? <RegisterForm kind="invite" token={token} email={inv.email} defaultName={inv.displayName} /> : (
        <div className="authcard glass">
          <h1 style={{ fontSize: 22 }}>Invitation not valid</h1>
          <p className="sub">This link is expired, already used, or was revoked. Ask an admin for a new one.</p>
          <Link className="btn" href="/login" style={{ textAlign: "center", display: "grid", alignItems: "center" }}>Go to sign in</Link>
        </div>
      )}
    </div>
  );
}
