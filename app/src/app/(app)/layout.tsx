import { redirect } from "next/navigation";
import { after } from "next/server";
import { headers } from "next/headers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SideNav, TabBar } from "@/components/Nav";
import { canManage, getCtx } from "@/lib/session";
import { auth } from "@/lib/auth";
import { db, schema } from "@/db";
import { count } from "drizzle-orm";
import { scope } from "@/lib/leads";
import { AutoSync } from "@/components/AutoSync";
import { syncIfStale } from "@/lib/syncstale";

export const maxDuration = 60;

export default async function AppLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  const ctx = await getCtx();
  if (!ctx) {
    const s = await auth.api.getSession({ headers: await headers() });
    if (!s) redirect("/login");
    const owner = process.env.OWNER_EMAIL?.trim().toLowerCase();
    if (owner && s.user.email.toLowerCase() === owner) {
      const [{ n }] = await db.select({ n: count() }).from(schema.workspace);
      if (n === 0) redirect("/setup"); // interrupted registration: let the owner finish setup
    }
    return (
      <div className="authwrap"><div className="authcard glass">
        <h1 style={{ fontSize: 22 }}>No access</h1>
        <p>Your account ({s.user.email}) is not an active member of this workspace. Ask an admin for an invitation.</p>
      </div></div>
    );
  }
  const [[o], [u]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.followUpTask)
      .innerJoin(schema.lead, eq(schema.lead.id, schema.followUpTask.leadId))
      .where(and(scope(ctx), isNull(schema.lead.closedAt), eq(schema.followUpTask.status, "pending"), sql`${schema.followUpTask.dueAt} < now()`)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.notification)
      .where(and(eq(schema.notification.memberId, ctx.memberId), isNull(schema.notification.readAt))),
  ]);
  // The scheduler only fires every few hours, so opening the app also refreshes a stale sheet in the background.
  // syncConnection has its own overlap lock, so concurrent visitors cannot double-run it.
  after(syncIfStale);
  const counts = { overdue: o.n, unread: u.n };
  const mgr = canManage(ctx);
  return (
    <div className="shell">
      <SideNav name={ctx.name} role={ctx.role} isManager={mgr} counts={counts} />
      <main className="main">{children}</main>
      {modal}
      <AutoSync />
      <TabBar isManager={mgr} counts={counts} />
    </div>
  );
}
