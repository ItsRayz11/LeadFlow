import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { canManage, requireCtx } from "@/lib/session";
import {
  PERIODS, bySource, byOwner, daily, milestones, parseFilters, snapshot, sourceOptions, summary, type Filters,
} from "@/lib/insights";

export const dynamic = "force-dynamic";
type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const hrs = (h: number | null) => (h == null ? "–" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
const label = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function qs(f: Filters, over: Partial<Record<"period" | "owner" | "source", string | undefined>>) {
  const p = new URLSearchParams();
  const v = { period: f.period, owner: f.ownerId, source: f.source, ...over };
  for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
  return p.toString();
}

function Delta({ now, before }: { now: number; before: number }) {
  if (!before && !now) return <span className="sub">No change</span>;
  if (!before) return <span className="sub">New: none in the period before</span>;
  const d = Math.round(((now - before) / before) * 100);
  return <span className="sub">{d >= 0 ? "▲ +" : "▼ "}{d}% vs previous period ({before})</span>;
}

function Stat({ k, v, now, before }: { k: string; v: string | number; now?: number; before?: number }) {
  return (
    <div className="stat"><span className="d">{k}</span><span className="v num">{v}</span>{now != null && before != null && <Delta now={now} before={before} />}</div>
  );
}

export default async function Insights({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await requireCtx();
  const sp = await searchParams;
  const f = parseFilters(c, { period: one(sp.period), owner: one(sp.owner), source: one(sp.source) });
  const mgr = canManage(c);

  const [cur, prev, snap, days, owners, sources, ms, srcOpts, members] = await Promise.all([
    summary(c, f, 0), summary(c, f, 1), snapshot(c, f), daily(c, f), byOwner(c, f), bySource(c, f), milestones(c, f), sourceOptions(c),
    mgr ? db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName }).from(schema.workspaceMember)
      .where(and(eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true))) : Promise.resolve([]),
  ]);
  const max = Math.max(1, ...days.map((d) => Math.max(d.newLeads, d.contacted, d.converted)));
  const empty = cur.newLeads === 0 && snap.active === 0;
  const periodLabel = PERIODS.find((p) => p.key === f.period)!.label;

  return (
    <>
      <header className="top">
        <div><h1>Insights</h1><p>{c.role === "bd" ? "Your own leads only." : "Everything is counted from real records in your time zone"} · {c.tz}</p></div>
        <div className="acts"><a className="btn ghost" href={`/insights/export?${qs(f, {})}`} style={{ display: "inline-flex", alignItems: "center" }}>Export CSV</a></div>
      </header>

      <nav className="chips" aria-label="Period">
        {PERIODS.map((p) => (
          <Link key={p.key} className={`chip${f.period === p.key ? " primary" : ""}`} href={`/insights?${qs(f, { period: p.key })}`} aria-current={f.period === p.key ? "true" : undefined}>{p.label}</Link>
        ))}
      </nav>

      <form method="get" className="grid2" style={{ alignItems: "end" }}>
        <input type="hidden" name="period" value={f.period} />
        {mgr && (
          <label className="field"><span>Team member</span>
            <select name="owner" defaultValue={f.ownerId ?? ""}><option value="">Everyone</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        )}
        <label className="field"><span>Source</span>
          <select name="source" defaultValue={f.source ?? ""}><option value="">All sources</option>{srcOpts.map((s) => <option key={s}>{s}</option>)}</select></label>
        <div><button className="btn ghost">Apply</button></div>
      </form>

      {empty && (
        <section className="panel glass"><h2>Nothing to show yet</h2>
          <p className="sub">Numbers appear as soon as leads are added or imported from the sheet. Nothing here is estimated.</p></section>
      )}

      <section className="panel glass">
        <h2>{periodLabel}</h2>
        <div className="stat3">
          <Stat k="New leads" v={cur.newLeads} now={cur.newLeads} before={prev.newLeads} />
          <Stat k="First contacts made" v={cur.firstContacted} now={cur.firstContacted} before={prev.firstContacted} />
          <Stat k="Contact attempts logged" v={cur.attempts} now={cur.attempts} before={prev.attempts} />
          <Stat k="Converted" v={cur.converted} now={cur.converted} before={prev.converted} />
          <Stat k="Closed or dropped" v={cur.closed} now={cur.closed} before={prev.closed} />
          <Stat k="Average time to first contact" v={hrs(cur.avgFirstContactHrs)} />
          <Stat k="Follow-up deadlines missed" v={cur.missed} now={cur.missed} before={prev.missed} />
        </div>
        <p className="sub">Conversion of new leads in this period: {pct(ms.converted, ms.leads)}. Leads can convert after the period they arrived in, so small periods understate it.</p>
      </section>

      <section className="panel glass">
        <h2>Right now</h2>
        <div className="stat3">
          <Stat k="Active leads" v={snap.active} />
          <Stat k="Unassigned" v={snap.unassigned} />
          <Stat k="Overdue follow-ups" v={snap.overdue} />
        </div>
      </section>

      <section className="panel glass">
        <h2>Day by day</h2>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Day</th><th>New</th><th>First contacted</th><th>Converted</th><th aria-label="New leads bar"></th></tr></thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{label(d.day)}</td><td className="num">{d.newLeads}</td><td className="num">{d.contacted}</td><td className="num">{d.converted}</td>
                  <td style={{ width: "30%" }}><div style={{ height: 8, borderRadius: 4, background: "var(--accent)", width: `${(d.newLeads / max) * 100}%`, minWidth: d.newLeads ? 4 : 0 }} role="img" aria-label={`${d.newLeads} new leads`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {mgr && (
        <section className="panel glass">
          <h2>By team member</h2>
          <p className="sub">Shown side by side on purpose. Leads handed over is not a measure of performance, so there is no ranking.</p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Name</th><th>Open leads</th><th>Overdue now</th><th>First contacts</th><th>Attempts logged</th><th>Converted</th><th>Deadlines missed</th><th>Avg to first contact</th></tr></thead>
              <tbody>
                {owners.length === 0 && <tr><td colSpan={8} className="sub">No team members.</td></tr>}
                {owners.map((o) => (
                  <tr key={o.memberId}>
                    <td><Link href={`/insights?${qs(f, { owner: o.memberId })}`}>{o.name}</Link></td>
                    <td className="num">{o.open}</td><td className="num">{o.overdue}</td><td className="num">{o.firstContacted}</td><td className="num">{o.attempts}</td>
                    <td className="num">{o.converted}</td><td className="num">{o.missed}</td><td className="num">{hrs(o.avgFirstContactHrs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="grid2">
        <section className="panel glass">
          <h2>By source</h2>
          <p className="sub">Leads that arrived in the period.</p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Source</th><th>Leads</th><th>Contacted</th><th>Converted</th></tr></thead>
              <tbody>
                {sources.length === 0 && <tr><td colSpan={4} className="sub">None in this period.</td></tr>}
                {sources.map((s) => (
                  <tr key={s.source}><td>{s.source}</td><td className="num">{s.leads}</td><td className="num">{s.contacted} ({pct(s.contacted, s.leads)})</td><td className="num">{s.converted} ({pct(s.converted, s.leads)})</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel glass">
          <h2>Activation milestones</h2>
          <p className="sub">Of {ms.leads} leads that arrived in the period.</p>
          <dl className="kv" style={{ gridTemplateColumns: "190px 1fr" }}>
            <dt>App downloaded</dt><dd className="num">{ms.appDownloaded} ({pct(ms.appDownloaded, ms.leads)})</dd>
            <dt>Referral code shared</dt><dd className="num">{ms.referralShared} ({pct(ms.referralShared, ms.leads)})</dd>
            <dt>Card purchased</dt><dd className="num">{ms.cardPurchased} ({pct(ms.cardPurchased, ms.leads)})</dd>
            <dt>Spending started</dt><dd className="num">{ms.spendingStarted} ({pct(ms.spendingStarted, ms.leads)})</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
