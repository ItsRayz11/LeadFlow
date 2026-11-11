import Link from "next/link";
import { AlarmClock, CalendarClock, CalendarDays, CheckCircle2, Clock, Layers, MapPin, PhoneCall, Plus, Sparkles, UserPlus, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { canManage, requireCtx } from "@/lib/session";
import { overviewMetrics } from "@/lib/leads";
import { bySource, byOwner, daily, pipeline, summary } from "@/lib/insights";
import { ConversionsPanel, FollowupsPanel, SourcesPanel, TabNav, TeamPanel, type TabKey } from "@/components/OverviewTabs";
import { Pipeline } from "@/components/Pipeline";
import { RefreshButton } from "@/components/RefreshButton";
import { sweepSoon } from "@/lib/sweep";
import { SignOutButton } from "@/components/Nav";

export const dynamic = "force-dynamic";

type Tone = "red" | "amber" | "blue" | "green" | "purple" | "teal";

function Tile ({ href, tone, icon, label, v, sub, chip, cls = "" }: { href: string; tone: Tone; icon: ReactNode; label: string; v: number; sub: string; chip?: ReactNode; cls?: string }) {
  return (
  <Link href={href} className={`metric tone-${tone} ${cls}`} style={{ textDecoration: "none", color: "inherit" }}>
    <span className="m-ic">{icon}</span>
    <span className="m-body">
      <span className="label">{label}</span>
      <span className="v num">{v}</span>
      <span className="s">{sub}</span>
    </span>
    {chip}
  </Link>
);
}

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await requireCtx();
  const mgr = canManage(c);
  const raw = (await searchParams).tab;
  const asked = Array.isArray(raw) ? raw[0] : raw;
  const tab: TabKey = asked === "sources" || asked === "followups" || asked === "conversions" || (asked === "team" && mgr) ? asked : "overview";
  const f = { period: "7d" } as const;
  sweepSoon(c.workspaceId);
  const [m, pipe, sum, src, owners, days] = await Promise.all([
    overviewMetrics(c), pipeline(c, f),
    tab === "followups" || tab === "conversions" ? summary(c, f) : null,
    tab === "sources" ? bySource(c, f) : null,
    tab === "team" ? byOwner(c, f) : null,
    tab === "conversions" ? daily(c, f) : null,
  ]);
  const pct = m.newYesterday ? Math.round(((m.newToday - m.newYesterday) / m.newYesterday) * 100) : null;
  const empty = m.active === 0 && m.newToday === 0;
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: c.tz });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: c.tz });

  return (
    <>
      <header className="top">
        <div>
          <h1>Good day, {c.name} <span aria-hidden="true">👋</span></h1>
          <p className="when">
            <span><CalendarDays size={14} /> {dateStr}</span>
            <i aria-hidden="true" />
            <span><Clock size={14} /> {timeStr}</span>
            <i aria-hidden="true" />
            <span><MapPin size={14} /> {c.tz}</span>
          </p>
        </div>
        <div className="acts">
          <RefreshButton />
          <Link className="btn add" href="/leads/new"><Plus size={18} /> Add Lead</Link>
          <SignOutButton />
        </div>
      </header>

      {empty && (
        <section className="panel glass">
          <h2>No leads yet</h2>
          <p className="sub">Add a lead by hand now. Once the Google Sheet is connected, new rows arrive here on their own.</p>
          <div className="chips"><Link className="chip primary" href="/leads/new">Add the first lead</Link></div>
        </section>
      )}

      <section className="metrics" aria-label="Key numbers">
        <Tile href="/followups?view=overdue" tone="red" icon={<AlarmClock size={22} />} label="Overdue follow-ups" v={m.overdue} sub={m.overdue ? "Stay visible until resolved" : "All clear"} />
        <Tile href="/followups?view=today" tone="amber" icon={<CalendarClock size={22} />} label="Due today" v={m.dueToday} sub="Still ahead today" />
        <Tile href="/leads?seg=unassigned" tone="blue" icon={<UserPlus size={22} />} label="Unassigned" v={m.unassigned} sub="Need a BD" />
        <Tile
          href="/leads?seg=new_today" tone="green" icon={<Sparkles size={22} />} label="New today" v={m.newToday}
          sub={pct == null ? `Yesterday: ${m.newYesterday}` : `${pct >= 0 ? "↑" : "↓"} ${pct >= 0 ? "+" : ""}${pct}% vs yesterday (${m.newYesterday})`}
        />
        <Tile href="/leads" tone="blue" icon={<PhoneCall size={22} />} label="Contacted today" v={m.contactedToday} sub="Confirmed by a BD" />
        <Tile href="/leads" tone="green" icon={<CheckCircle2 size={22} />} label="Converted today" v={m.convertedToday} sub={`Active leads: ${m.active}`} />
        <Tile href="/leads?seg=closed" tone="purple" icon={<XCircle size={22} />} label="Closed or dropped" v={m.closedToday} sub="Today" />
        <Tile href="/leads?seg=active" tone="teal" icon={<Layers size={22} />} label="Total active leads" v={m.active} sub="In progress" />
      </section>

      {!empty && <TabNav active={tab} isManager={mgr} />}
      {!empty && tab === "overview" && <Pipeline p={pipe} compact />}
      {!empty && tab === "sources" && src && <SourcesPanel rows={src} />}
      {!empty && tab === "team" && owners && <TeamPanel rows={owners} />}
      {!empty && tab === "followups" && sum && <FollowupsPanel s={sum} p={pipe} overdue={m.overdue} dueToday={m.dueToday} />}
      {!empty && tab === "conversions" && sum && days && <ConversionsPanel s={sum} p={pipe} days={days} />}
      {!empty && <p className="sub"><Link href="/insights">See the full breakdown in Insights</Link></p>}
    </>
  );
}
