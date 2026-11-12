import Link from "next/link";
import { LeadLink } from "@/components/LeadLink";
import { LeadViewToggle } from "@/components/LeadViewToggle";
import { requireCtx, canWrite } from "@/lib/session";
import { SEGS, listLeads, relTime, segCounts, trackedTabs, type Seg } from "@/lib/leads";
import { Download, Share2, CreditCard, Wallet } from "lucide-react";
import { TabFilter } from "@/components/TabFilter";
import { parseTabKeys, visibleTabTitle } from "@/lib/tabs";

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
  const tabs = await trackedTabs(c);
  // Only tabs this workspace really has; anything else in the address is ignored.
  const known = new Set(tabs.map((t) => t.key));
  const tab = parseTabKeys(sp.tab).filter((k) => known.has(k) || !k.includes(":"));
  const [rows, counts] = await Promise.all([listLeads(c, seg, q, tab), segCounts(c, tab)]);
  const tabQ = tab.length ? `&tab=${tab.join(",")}` : "";
  const now = Date.now();

  const due = (r: (typeof rows)[number]) =>
    r.closedAt ? <span className="pill ok">{r.outcome ?? "closed"}</span>
    : r.nextFollowUpAt ? <span className={`pill ${r.nextFollowUpAt.getTime() < now ? "crit" : "acc"}`}>{relTime(r.nextFollowUpAt, now)}</span>
    : <span className="pill">No follow-up</span>;
  const owner = (r: (typeof rows)[number]) => r.owner ?? <span className="pill crit">Unassigned</span>;

  const pips = (r: (typeof rows)[number]) => (
    <span className="ms-pips" title={`${r.ms} of 4 milestones: ${[r.mApp && "app downloaded", r.mRef && "referral shared", r.mCard && "card purchased", r.mSpend && "spending started"].filter(Boolean).join(", ") || "none yet"}`}>
      {([[r.mApp, Download, "App downloaded"], [r.mRef, Share2, "Referral shared"], [r.mCard, CreditCard, "Card purchased"], [r.mSpend, Wallet, "Spending started"]] as const).map(([on, Ic, l]) => (
        <i key={l} className={on ? "on" : ""} aria-label={`${l}: ${on ? "yes" : "no"}`}><Ic size={10} aria-hidden /></i>))}
      <em className="num">{r.ms}/4</em>
    </span>
  );

  return (
    <>
      <header className="top slim">
        <div><h1>Leads</h1><p>{rows.length} shown</p></div>
        <div className="acts">
          <LeadViewToggle />
          {canWrite(c) && <Link className="btn sm" href="/leads/new" style={{ display: "inline-flex", alignItems: "center" }}>Add lead</Link>}
        </div>
      </header>

      <section className="panel glass tight">
        <div className="toolbar">
          <form action="/leads">
            <input type="hidden" name="seg" value={seg} />
            {tab.length > 0 && <input type="hidden" name="tab" value={tab.join(",")} />}
            <label className="tb-search"><span className="sr">Search name or phone</span><input type="search" name="q" defaultValue={q} placeholder="Search name or phone" /></label>
          </form>
          {tabs.length > 0 && <TabFilter tabs={tabs} applied={tab.filter((k) => known.has(k))} seg={seg} q={q} />}
        </div>
        <nav className="fseg" aria-label="Lead status filters">
          {SEGS.map(([k, label]) => (
            <Link key={k} href={`/leads?seg=${k}${tabQ}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={seg === k ? "on" : ""}>{label} <span className="c">{counts[k]}</span></Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          <div className="empty">{q || seg !== "all" || tab.length ? "No leads match these filters." : "No leads yet. Add one, or connect the Google Sheet."}</div>
        ) : (
          <>
            <div className="tbl"><div className="tblwrap dtbl"><table>
              <thead><tr><th>Name</th><th>Owner</th><th>Status</th><th>Next follow-up</th><th>Source</th><th>Sheet tab</th><th>Milestones</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td><LeadLink id={r.id} style={{ color: "inherit", textDecoration: "none" }}><b>{r.name}</b><div className="sub num">{r.phone}</div></LeadLink></td>
                  <td>{owner(r)}</td><td><span className="pill acc">{STATUS[r.status]}</span></td><td>{due(r)}</td><td className="wrap">{r.source}</td><td className="tabcell" title={r.tabTitle ? visibleTabTitle(r.tabTitle) : undefined}>{r.tabTitle ? visibleTabTitle(r.tabTitle) : "—"}</td><td>{pips(r)}</td>
                </tr>))}</tbody>
            </table></div></div>
            <div className="cards m">{rows.map((r) => (
              <LeadLink key={r.id} id={r.id} className="lead" style={{ color: "inherit", textDecoration: "none" }}>
                <div className="lead-top"><div><b>{r.name}</b><div className="sub">{r.owner ?? "Unassigned"} · {r.source}{r.tabTitle ? ` · ${visibleTabTitle(r.tabTitle)}` : ""} · {STATUS[r.status]}</div></div>{due(r)}</div>
              </LeadLink>))}</div>
          </>
        )}
      </section>
    </>
  );
}
