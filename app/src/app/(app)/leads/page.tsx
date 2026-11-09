import Link from "next/link";
import { LeadLink } from "@/components/LeadLink";
import { LeadViewToggle } from "@/components/LeadViewToggle";
import { requireCtx, canWrite } from "@/lib/session";
import { SEGS, listLeads, relTime, segCounts, type Seg } from "@/lib/leads";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  new: "New", contacted: "Contacted", interested: "Interested", proposal_sent: "Proposal sent",
  converted: "Converted", not_interested: "Not interested", no_response: "No response", cold: "Cold",
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await requireCtx();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const seg = (SEGS.some(([k]) => k === one(sp.seg)) ? one(sp.seg) : "all") as Seg;
  const q = one(sp.q);
  const [rows, counts] = await Promise.all([listLeads(c, seg, q), segCounts(c)]);
  const now = Date.now();

  const due = (r: (typeof rows)[number]) =>
    r.closedAt ? <span className="pill ok">{r.outcome ?? "closed"}</span>
    : r.nextFollowUpAt ? <span className={`pill ${r.nextFollowUpAt.getTime() < now ? "crit" : "acc"}`}>{relTime(r.nextFollowUpAt, now)}</span>
    : <span className="pill">No follow-up</span>;
  const owner = (r: (typeof rows)[number]) => r.owner ?? <span className="pill crit">Unassigned</span>;

  return (
    <>
      <header className="top">
        <div><h1>Leads</h1><p>{rows.length} shown</p></div>
        {canWrite(c) && <Link className="btn" href="/leads/new" style={{ display: "inline-flex", alignItems: "center" }}>Add lead</Link>}
      </header>
      <LeadViewToggle />

      <section className="panel glass">
        <form className="filters" action="/leads">
          <input type="hidden" name="seg" value={seg} />
          <label className="field"><span>Search name or phone</span><input type="search" name="q" defaultValue={q} placeholder="Search" /></label>
        </form>
        <div className="seg">
          {SEGS.map(([k, label]) => (
            <Link key={k} href={`/leads?seg=${k}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={seg === k ? "on" : ""}>{label} <span className="c">{counts[k]}</span></Link>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="empty">{q || seg !== "all" ? "No leads match these filters." : "No leads yet. Add one, or connect the Google Sheet."}</div>
        ) : (
          <>
            <div className="tbl"><div className="tblwrap"><table>
              <thead><tr><th>Name</th><th>Owner</th><th>Status</th><th>Next follow-up</th><th>Source</th><th>Milestones</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td><LeadLink id={r.id} style={{ color: "inherit", textDecoration: "none" }}><b>{r.name}</b><div className="sub num">{r.phone}</div></LeadLink></td>
                  <td>{owner(r)}</td><td><span className="pill acc">{STATUS[r.status]}</span></td><td>{due(r)}</td><td>{r.source}</td><td className="num">{r.ms}/4</td>
                </tr>))}</tbody>
            </table></div></div>
            <div className="cards m">{rows.map((r) => (
              <LeadLink key={r.id} id={r.id} className="lead" style={{ color: "inherit", textDecoration: "none" }}>
                <div className="lead-top"><div><b>{r.name}</b><div className="sub">{r.owner ?? "Unassigned"} · {r.source} · {STATUS[r.status]}</div></div>{due(r)}</div>
              </LeadLink>))}</div>
          </>
        )}
      </section>
    </>
  );
}
