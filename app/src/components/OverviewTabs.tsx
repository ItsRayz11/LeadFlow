import Link from "next/link";
import { BarChart3, Clock, Grid3x3, TrendingUp, Users } from "lucide-react";
import type { DayRow, OwnerRow, Pipeline as P, SourceRow, Summary } from "@/lib/insights";

export type TabKey = "overview" | "sources" | "team" | "followups" | "conversions";
export const TAB_DEFS: { key: TabKey; label: string; Icon: typeof Clock; manager?: boolean }[] = [
  { key: "overview", label: "Lead Overview", Icon: BarChart3 },
  { key: "sources", label: "Source / Sheet Tabs", Icon: Grid3x3 },
  { key: "team", label: "Team Performance", Icon: Users, manager: true },
  { key: "followups", label: "Follow-up Activity", Icon: Clock },
  { key: "conversions", label: "Conversions", Icon: TrendingUp },
];

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const hrs = (h: number | null) => (h == null ? "–" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
const dayLabel = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const STAGE: Record<string, string> = { contact_started: "Contact started", h24: "Follow-up", h48: "48H follow-up", final: "Final follow-up", completed: "No follow-up planned" };
const STAGE_ORDER = ["contact_started", "h24", "h48", "final", "completed"];

export function TabNav({ active, isManager }: { active: TabKey; isManager: boolean }) {
  return (
    <nav className="otabs" aria-label="Overview sections">
      {TAB_DEFS.filter((t) => isManager || !t.manager).map(({ key, label, Icon }) => (
        <Link key={key} href={key === "overview" ? "/" : `/?tab=${key}`} scroll={false} className={active === key ? "on" : ""} aria-current={active === key ? "page" : undefined}>
          <Icon size={18} />{label}
        </Link>
      ))}
    </nav>
  );
}

function Stat({ k, v, sub }: { k: string; v: string | number; sub?: string }) {
  return <div className="stat"><span className="d">{k}</span><span className="v num">{v}</span>{sub && <span className="sub">{sub}</span>}</div>;
}

export function SourcesPanel({ rows }: { rows: SourceRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <section className="panel glass">
      <h2>Source / sheet tabs</h2>
      <p className="sub">Leads that arrived in the last 7 days, by where they came from.</p>
      <div className="tblwrap"><table style={{ minWidth: 0 }}>
        <thead><tr><th>Source</th><th>Leads</th><th>Contacted</th><th>Converted</th><th>Volume</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} className="sub">None in this period.</td></tr>}
          {rows.map((s) => (
            <tr key={s.source}>
              <td><b>{s.source}</b></td><td className="num">{s.leads}</td>
              <td className="num">{s.contacted} ({pct(s.contacted, s.leads)})</td><td className="num">{s.converted} ({pct(s.converted, s.leads)})</td>
              <td style={{ width: "28%" }}><div className="track"><div style={{ background: "var(--accent)", width: `${(s.leads / max) * 100}%`, minWidth: s.leads ? 4 : 0 }} role="img" aria-label={`${s.leads} leads`} /></div></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="sub">Sheet tabs are managed under <Link href="/integrations">Integrations</Link>; filter the lead list by tab on <Link href="/leads">Leads</Link>.</p>
    </section>
  );
}

export function TeamPanel({ rows }: { rows: OwnerRow[] }) {
  return (
    <section className="panel glass">
      <h2>Team performance</h2>
      <p className="sub">Last 7 days. Shown side by side, not ranked: leads handed over is not a measure of performance.</p>
      <div className="tblwrap"><table style={{ minWidth: 0 }}>
        <thead><tr><th>Name</th><th>Open</th><th>Overdue</th><th>First contacts</th><th>Attempts</th><th>Converted</th><th>Missed</th><th>Avg first contact</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="sub">No team members.</td></tr>}
          {rows.map((o) => (
            <tr key={o.memberId}>
              <td><b>{o.name}</b></td><td className="num">{o.open}</td><td className="num">{o.overdue}</td><td className="num">{o.firstContacted}</td>
              <td className="num">{o.attempts}</td><td className="num">{o.converted}</td><td className="num">{o.missed}</td><td className="num">{hrs(o.avgFirstContactHrs)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

export function FollowupsPanel({ s, p, overdue, dueToday }: { s: Summary; p: P; overdue: number; dueToday: number }) {
  const stages = new Map(p.stages.map((x) => [x.key, x.n]));
  const max = Math.max(1, ...STAGE_ORDER.map((k) => stages.get(k) ?? 0));
  return (
    <section className="panel glass">
      <h2>Follow-up activity</h2>
      <div className="stat3">
        <Stat k="Overdue now" v={overdue} sub="Open leads past their follow-up time" />
        <Stat k="Due today" v={dueToday} sub="Still ahead today" />
        <Stat k="Contact attempts (7 days)" v={s.attempts} />
        <Stat k="Deadlines missed (7 days)" v={s.missed} />
        <Stat k="Avg time to first contact" v={hrs(s.avgFirstContactHrs)} />
      </div>
      <h3>Open leads by follow-up stage</h3>
      <div className="tblwrap"><table style={{ minWidth: 0 }}>
        <tbody>
          {STAGE_ORDER.map((k) => (
            <tr key={k}><td>{STAGE[k]}</td><td className="num"><b>{stages.get(k) ?? 0}</b></td>
              <td style={{ width: "50%" }}><div className="track"><div style={{ background: "var(--accent)", width: `${((stages.get(k) ?? 0) / max) * 100}%`, minWidth: stages.get(k) ? 4 : 0 }} /></div></td></tr>
          ))}
        </tbody>
      </table></div>
      <p className="sub"><Link href="/followups">Open the follow-up queue</Link></p>
    </section>
  );
}

export function ConversionsPanel({ s, p, days }: { s: Summary; p: P; days: DayRow[] }) {
  const max = Math.max(1, ...days.map((d) => d.converted));
  return (
    <section className="panel glass">
      <h2>Conversions</h2>
      <div className="stat3">
        <Stat k="Converted (7 days)" v={s.converted} />
        <Stat k="Converted overall" v={p.converted} sub={`${pct(p.converted, p.total)} of all leads`} />
        <Stat k="Interest → conversion" v={pct(p.converted, p.interestedEver)} sub={`${p.converted} of ${p.interestedEver} who showed interest`} />
        <Stat k="Dropped after interest" v={p.lostAfterInterest} sub={`${pct(p.lostAfterInterest, p.interestedEver)} of those interested`} />
      </div>
      <h3>Day by day</h3>
      <div className="tblwrap"><table style={{ minWidth: 0 }}>
        <thead><tr><th>Day</th><th>New</th><th>Contacted</th><th>Converted</th><th></th></tr></thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.day}><td>{dayLabel(d.day)}</td><td className="num">{d.newLeads}</td><td className="num">{d.contacted}</td><td className="num"><b>{d.converted}</b></td>
              <td style={{ width: "30%" }}><div className="track"><div style={{ background: "#16a34a", width: `${(d.converted / max) * 100}%`, minWidth: d.converted ? 4 : 0 }} /></div></td></tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}
