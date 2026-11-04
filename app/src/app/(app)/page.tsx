import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { overviewMetrics } from "@/lib/leads";
import { sweepSoon } from "@/lib/sweep";
import { SignOutButton } from "@/components/Nav";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const c = await requireCtx();
  sweepSoon(c.workspaceId);
  const m = await overviewMetrics(c);
  const pct = m.newYesterday ? Math.round(((m.newToday - m.newYesterday) / m.newYesterday) * 100) : null;
  const empty = m.active === 0 && m.newToday === 0;

  const Tile = ({ href, cls = "", label, v, sub }: { href: string; cls?: string; label: string; v: number; sub: string }) => (
    <Link href={href} className={`metric glass ${cls}`} style={{ textDecoration: "none", color: "inherit" }}>
      <span className="label">{label}</span><span className="v num">{v}</span><span className="s">{sub}</span>
    </Link>
  );

  return (
    <>
      <header className="top">
        <div>
          <h1>Good day, {c.name}</h1>
          <p>{new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", timeZone: c.tz })} · {c.tz}</p>
        </div>
        <div className="acts"><Link className="btn" href="/leads/new" style={{ display: "inline-flex", alignItems: "center" }}>Add lead</Link><SignOutButton /></div>
      </header>

      {empty && (
        <section className="panel glass">
          <h2>No leads yet</h2>
          <p className="sub">Add a lead by hand now. Once the Google Sheet is connected, new rows arrive here on their own.</p>
          <div className="chips"><Link className="chip primary" href="/leads/new">Add the first lead</Link></div>
        </section>
      )}

      <section className="metrics" aria-label="Key numbers">
        <Tile href="/followups?view=overdue" cls="urgent" label="Overdue follow-ups" v={m.overdue} sub={m.overdue ? "Stay visible until resolved" : "All clear"} />
        <Tile href="/followups?view=today" cls="due" label="Due today" v={m.dueToday} sub="Still ahead today" />
        <Tile href="/leads?seg=unassigned" label="Unassigned" v={m.unassigned} sub="Need a BD" />
        <Tile href="/leads?seg=new_today" label="New today" v={m.newToday} sub={pct == null ? `Yesterday: ${m.newYesterday}` : `${pct >= 0 ? "▲ +" : "▼ "}${pct}% vs yesterday (${m.newYesterday})`} />
        <Tile href="/leads" label="Contacted today" v={m.contactedToday} sub="Confirmed by a BD" />
        <Tile href="/leads" label="Converted today" v={m.convertedToday} sub={`Active leads: ${m.active}`} />
        <Tile href="/leads?seg=closed" label="Closed or dropped" v={m.closedToday} sub="Today" />
      </section>
    </>
  );
}
