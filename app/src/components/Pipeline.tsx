import { Fragment } from "react";
import Link from "next/link";
import { CheckCircle2, Flame, Layers, MinusCircle, PhoneCall, Star, Target, XCircle, type LucideIcon } from "lucide-react";
import type { Pipeline as P } from "@/lib/insights";

const STAGE: Record<string, string> = { contact_started: "Contact started", h24: "Follow-up", h48: "48H follow-up", final: "Final follow-up", completed: "No follow-up planned" };
const STATUS: Record<string, string> = {
  new: "New", contacted: "Contacted", interested: "Interested", proposal_sent: "Proposal sent", converted: "Converted",
  not_interested: "Not interested", no_response: "No response", cold: "Cold",
};
const STAGE_ORDER = ["contact_started", "h24", "h48", "final", "completed"];
const STATUS_ORDER = ["new", "contacted", "interested", "proposal_sent", "converted", "not_interested", "no_response", "cold"];

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

/** conic-gradient for the donut; slices overlap in real data (interested vs interested-now), so scale to the sum. */
function donut(slices: { n: number; color: string }[], total: number) {
  const sum = slices.reduce((s, x) => s + x.n, 0);
  if (!total || !sum) return "var(--edge)";
  let at = 0;
  const stops = slices.filter((s) => s.n > 0).map((s) => { const from = at; at += (s.n / sum) * 100; return `${s.color} ${from}% ${at}%`; });
  return `conic-gradient(${stops.join(",")})`;
}

/** Where every lead stands and how far each got. `compact` is the short version for the overview page. */
export function Pipeline({ p, compact = false }: { p: P; compact?: boolean }) {
  const rows: { label: string; n: number; href?: string; tone: string; Icon: LucideIcon; hint?: string }[] = [
    { label: "All leads", n: p.total, href: "/leads", tone: "#0f5f57", Icon: Layers },
    { label: "Contacted", n: p.contacted, tone: "#2dd4bf", Icon: PhoneCall, hint: "Anyone moved past “new”" },
    { label: "Interested at some point", n: p.interestedEver, tone: "#facc15", Icon: Star, hint: "Interested now, or was at any time" },
    { label: "Interested right now", n: p.interestedNow, href: "/leads?seg=interested", tone: "#3b82f6", Icon: Flame },
    { label: "Converted", n: p.converted, href: "/leads?seg=converted", tone: "#16a34a", Icon: CheckCircle2 },
    { label: "Dropped after showing interest", n: p.lostAfterInterest, href: "/leads?seg=lost_interested", tone: "#ef4444", Icon: XCircle },
    { label: "Lost in total", n: p.lost, href: "/leads?seg=lost", tone: "#94a3b8", Icon: MinusCircle },
  ];
  const slices = [
    { label: "Contacted", n: p.contacted, color: "#2dd4bf" },
    { label: "Interested", n: p.interestedEver, color: "#facc15" },
    { label: "Interested Now", n: p.interestedNow, color: "#3b82f6" },
    { label: "Converted", n: p.converted, color: "#16a34a" },
    { label: "Lost", n: p.lost, color: "#94a3b8" },
  ];
  slices.push({ label: "Other", n: Math.max(0, p.total - slices.reduce((s, x) => s + x.n, 0)), color: "#e2e8f0" });
  const max = Math.max(1, p.total);
  const stageMap = new Map(p.stages.map((x) => [x.key, x.n]));
  const statusMap = new Map(p.statuses.map((x) => [x.key, x.n]));

  return (
    <section className="panel glass" aria-labelledby="pipeline-h">
      <h2 id="pipeline-h">Where your leads stand</h2>
      <div className="stat3 pstats">
        <div className="stat tone-green"><span className="m-ic"><CheckCircle2 size={22} /></span><span><span className="d">Converted</span><span className="v num">{p.converted}</span><span className="sub">{pct(p.converted, p.total)} of all leads</span></span></div>
        <div className="stat tone-blue"><span className="m-ic"><Target size={22} /></span><span><span className="d">Interested right now</span><span className="v num">{p.interestedNow}</span><span className="sub">{pct(p.interestedNow, p.total)} of all leads</span></span></div>
        <div className="stat tone-red"><span className="m-ic"><XCircle size={22} /></span><span><span className="d">Dropped after interest</span><span className="v num">{p.lostAfterInterest}</span><span className="sub">{pct(p.lostAfterInterest, p.interestedEver)} of everyone who showed interest</span></span></div>
        <div className="stat tone-purple"><span className="m-ic"><MinusCircle size={22} /></span><span><span className="d">Lost in total</span><span className="v num">{p.lost}</span><span className="sub">{pct(p.lost, p.total)} of all leads</span></span></div>
      </div>

      <div className={compact ? "pgrid" : undefined} style={{ minWidth: 0 }}>
        <div className="tblwrap" style={{ overflowX: "auto" }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Stage of the journey</th><th>Leads</th><th>Share of all</th><th>Progress</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td><span className="stg"><r.Icon size={18} style={{ color: r.tone }} />{r.href ? <Link href={r.href}>{r.label}</Link> : r.label}</span>{r.hint && !compact ? <div className="sub">{r.hint}</div> : null}</td>
                  <td className="num"><b>{r.n}</b></td>
                  <td className="num"><b>{pct(r.n, p.total)}</b></td>
                  <td style={{ width: "34%" }}><div className="track"><div style={{ background: r.tone, width: `${(r.n / max) * 100}%`, minWidth: r.n ? 4 : 0 }} role="img" aria-label={`${r.n} leads`} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {compact && (
          <div className="distro">
            <h3>Lead Distribution</h3>
            <div className="donutwrap">
              <div className="donut" role="img" aria-label={`${p.total} total leads`} style={{ background: donut(slices, p.total) }}>
                <div><b className="num">{p.total}</b><span>Total Leads</span></div>
              </div>
              <ul className="legend">
                {slices.map((s) => <li key={s.label}><i style={{ background: s.color }} />{s.label} – {pct(s.n, p.total)} ({s.n})</li>)}
              </ul>
            </div>
          </div>
        )}
      </div>

      {!compact && (
        <>
          <div className="grid2">
            <div>
              <h3>Open leads by follow-up stage</h3>
              <dl className="kv" style={{ gridTemplateColumns: "190px 1fr" }}>
                {STAGE_ORDER.map((k) => <Fragment key={k}><dt>{STAGE[k]}</dt><dd className="num">{stageMap.get(k) ?? 0}</dd></Fragment>)}
              </dl>
            </div>
            <div>
              <h3>All leads by status</h3>
              <dl className="kv" style={{ gridTemplateColumns: "190px 1fr" }}>
                {STATUS_ORDER.map((k) => <Fragment key={k}><dt>{STATUS[k]}</dt><dd className="num">{statusMap.get(k) ?? 0}</dd></Fragment>)}
              </dl>
            </div>
          </div>
          <h3>Why leads were lost</h3>
          <p className="sub">Not interested: {p.lostNotInterested} · No response: {p.lostNoResponse} · Other: {p.lostOther}{p.reasons.length ? <> · Reasons given: {p.reasons.map((r) => `${r.reason} (${r.n})`).join(", ")}</> : null}</p>
          <p className="sub">Interest is counted from outcomes logged in the CRM and statuses read from the sheet. A lead the sheet marked “Not Interested” without any earlier “Interested” on record is counted as lost, not as dropped after interest.</p>
        </>
      )}
    </section>
  );
}
