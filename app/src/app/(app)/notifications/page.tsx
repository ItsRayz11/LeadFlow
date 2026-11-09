import { LeadLink } from "@/components/LeadLink";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireCtx } from "@/lib/session";
import { sweepSoon } from "@/lib/sweep";
import { ActionForm, Submit } from "@/components/ActionForm";
import { markReadAction } from "../team/actions";

export const dynamic = "force-dynamic";

export default async function Alerts() {
  const c = await requireCtx();
  sweepSoon(c.workspaceId);
  const rows = await db.select().from(schema.notification).where(eq(schema.notification.memberId, c.memberId)).orderBy(desc(schema.notification.createdAt)).limit(100);
  const deliveries = rows.length
    ? await db.select().from(schema.notificationDelivery).where(inArray(schema.notificationDelivery.notificationId, rows.map((r) => r.id)))
    : [];
  const ext = new Map<string, { status: string; attempts: number; err: string | null }[]>();
  for (const d of deliveries) if (d.channel !== "in_app") ext.set(d.notificationId, [...(ext.get(d.notificationId) ?? []), { status: d.status, attempts: d.attempts, err: d.lastError }]);
  const unread = rows.filter((r) => !r.readAt).length;
  const kind: Record<string, string> = { due: "Due", overdue: "Overdue", escalation: "Escalation", assignment: "Assigned", advance: "Upcoming" };

  return (
    <>
      <header className="top">
        <div><h1>Alerts</h1><p>{unread} unread</p></div>
        {unread > 0 && <ActionForm action={markReadAction}><Submit className="chip" pendingText="Working">Mark all read</Submit></ActionForm>}
      </header>
      <section className="panel glass">
        {rows.length === 0 ? <div className="empty">No alerts yet. They appear when a follow-up is due, goes overdue, escalates, or a lead is assigned to you.</div> : (
          <div className="queue">{rows.map((n) => (
            <article key={n.id} className={`lead ${n.kind === "overdue" || n.kind === "escalation" ? "overdue" : ""}`} style={{ opacity: n.readAt ? 0.7 : 1 }}>
              <div className="lead-top">
                <div>{n.leadId ? <LeadLink id={n.leadId} style={{ color: "inherit", textDecoration: "none" }}><b>{n.title}</b></LeadLink> : <b>{n.title}</b>}
                  {n.body && <div className="sub">{n.body}</div>}
                  <div className="sub">{n.createdAt.toLocaleString([], { timeZone: c.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>
                <span className={`pill ${n.kind === "overdue" || n.kind === "escalation" ? "crit" : "acc"}`}>{kind[n.kind] ?? n.kind}</span>
              </div>
              {ext.get(n.id)?.map((d, i) => (
                <div key={i} className="sub">External message: {d.status === "sent" ? "sent" : d.status === "failed" ? `failed after ${d.attempts} tries${d.err ? ` (${d.err})` : ""}` : "queued. Not sent yet."}</div>
              ))}
              {!n.readAt && <ActionForm action={markReadAction}><input type="hidden" name="id" value={n.id} /><Submit className="chip" pendingText="Working">Mark read</Submit></ActionForm>}
            </article>))}</div>
        )}
      </section>
    </>
  );
}
