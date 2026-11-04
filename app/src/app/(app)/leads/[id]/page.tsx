import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireCtx } from "@/lib/session";
import { relTime, scope } from "@/lib/leads";

export const dynamic = "force-dynamic";

const MS = ["App downloaded", "Referral shared", "Card purchased", "Spending started"] as const;

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const c = await requireCtx();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [l] = await db.select().from(schema.lead).where(and(scope(c), eq(schema.lead.id, id))).limit(1);
  if (!l) notFound();
  const [owner] = l.ownerId ? await db.select({ n: schema.workspaceMember.displayName }).from(schema.workspaceMember).where(eq(schema.workspaceMember.id, l.ownerId)) : [];
  const acts = await db.select().from(schema.leadActivity).where(eq(schema.leadActivity.leadId, l.id)).orderBy(desc(schema.leadActivity.occurredAt)).limit(50);
  const ms = [l.appDownloadedAt, l.referralSharedAt, l.cardPurchasedAt, l.spendingStartedAt];
  const fmt = (d: Date) => d.toLocaleString([], { timeZone: c.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <>
      <header className="top">
        <div><h1>{l.name}</h1><p className="num">{l.phoneRaw ?? "No phone"} · {l.source}</p></div>
        <Link className="chip" href="/leads">Back to leads</Link>
      </header>
      <section className="panel glass">
        <div><span className="pill acc">{l.status.replace("_", " ")}</span>{" "}
          {l.closedAt ? <span className="pill ok">{l.outcome}</span> : l.nextFollowUpAt ? <span className="pill warn">{relTime(l.nextFollowUpAt)}</span> : <span className="pill">No follow-up</span>}</div>
        <dl className="kv">
          <dt>Owner</dt><dd>{owner?.n ?? "Unassigned"}</dd>
          <dt>Acquired</dt><dd>{fmt(l.acquiredAt)}</dd>
          <dt>Imported</dt><dd>{fmt(l.importedAt)}</dd>
          <dt>Attempts</dt><dd>{l.followUpAttempts}</dd>
          <dt>Last contact</dt><dd>{l.lastContactedAt ? fmt(l.lastContactedAt) : "Not yet"}</dd>
          <dt>Email</dt><dd>{l.email ?? "None"}</dd>
        </dl>
        <div className="acts">{MS.map((n, i) => <span key={n} className={`pill ${ms[i] ? "ok" : ""}`}>{n}{ms[i] ? "" : " (not yet)"}</span>)}</div>
      </section>
      <section className="panel glass">
        <h2>Timeline</h2>
        <ul className="tl">{acts.map((a) => <li key={a.id}><div>{a.summary ?? a.type}<div className="t">{fmt(a.occurredAt)}</div></div></li>)}</ul>
        <p className="sub">Logging contacts, notes, assignment and closing arrive with the follow-up engine, next.</p>
      </section>
    </>
  );
}
