import { Fragment } from "react";
import Link from "next/link";
import type { Pipeline as P } from "@/lib/insights";

const STAGE: Record<string, string> = { contact_started: "Contact started", h24: "24H follow-up", h48: "48H follow-up", final: "Final follow-up", completed: "No follow-up planned" };
const STATUS: Record<string, string> = {
  new: "New", contacted: "Contacted", interested: "Interested", proposal_sent: "Proposal sent", converted: "Converted",
  not_interested: "Not interested", no_response: "No response", cold: "Cold",
};
const STAGE_ORDER = ["contact_started", "h24", "h48", "final", "completed"];
const STATUS_ORDER = ["new", "contacted", "interested", "proposal_sent", "converted", "not_interested", "no_response", "cold"];

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

/** Where every lead stands and how far each got. `compact` is the short version for the overview page. */
export function Pipeline({ p, compact = false }: { p: P; compact?: boolean }) {
  const rows: { label: string; n: number; href?: string; tone?: string; hint?: string }[] = [
    { label: "All leads", n: p.total, href: "/leads" },
    { label: "Contacted", n: p.contacted, hint: "Anyone moved past “new”" },
    { label: "Interested at some point", n: p.interestedEver, hint: "Interested now, or was at any time" },
    { label: "Interested right now", n: p.interestedNow, href: "/leads?seg=interested", tone: "var(--accent)" },
    { label: "Converted", n: p.converted, href: "/leads?seg=converted", tone: "var(--ok, #1a7f4b)" },
    { label: "Dropped after showing interest", n: p.lostAfterInterest, href: "/leads?seg=lost_interested", tone: "var(--crit, #c0392b)" },
    { label: "Lost in total", n: p.lost, href: "/leads?seg=lost" },
  ];
  const max = Math.max(1, p.total);
  const stageMap = new Map(p.stages.map((x) => [x.key, x.n]));
  const statusMap = new Map(p.statuses.map((x) => [x.key, x.n]));

  return (
    <section className="panel glass" aria-labelledby="pipeline-h">
      <h2 id="pipeline-h">Where your leads stand</h2>
      <div className="stat3">
        <div className="stat"><span className="d">Converted</span><span className="v num">{p.converted}</span><span className="sub">{pct(p.converted, p.total)} of all leads</span></div>
        <div className="stat"><span className="d">Interested right now</span><span className="v num">{p.interestedNow}</span><span className="sub">{pct(p.converted, p.interestedEver)} of everyone who showed interest converted</span></div>
        <div className="stat"><span className="d">Dropped after interest</span><span className="v num">{p.lostAfterInterest}</span><span className="sub">{pct(p.lostAfterInterest, p.interestedEver)} of everyone who showed interest</span></div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Stage of the journey</th><th>Leads</th><th>Share of all</th><th aria-label="Bar"></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.href ? <Link href={r.href}>{r.label}</Link> : r.label}{r.hint && !compact ? <div className="sub">{r.hint}</div> : null}</td>
                <td className="num">{r.n}</td>
                <td className="num">{pct(r.n, p.total)}</td>
                <td style={{ width: "34%" }}><div style={{ height: 8, borderRadius: 4, background: r.tone ?? "var(--muted, #9aa5a0)", width: `${(r.n / max) * 100}%`, minWidth: r.n ? 4 : 0 }} role="img" aria-label={`${r.n} leads`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
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
