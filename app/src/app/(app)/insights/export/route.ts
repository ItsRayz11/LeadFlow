import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { byOwner, bySource, daily, parseFilters, toCsv } from "@/lib/insights";

export const dynamic = "force-dynamic";

/** CSV of the day-by-day, by-source and by-person tables, for the signed-in viewer's own scope. */
export async function GET(req: Request) {
  const c = await getCtx();
  if (!c) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const u = new URL(req.url).searchParams;
  const f = parseFilters(c, { period: u.get("period") ?? undefined, owner: u.get("owner") ?? undefined, source: u.get("source") ?? undefined });
  const [days, owners, sources] = await Promise.all([daily(c, f), byOwner(c, f), bySource(c, f)]);
  const rows: unknown[][] = [
    ["Day by day"], ["Day", "New leads", "First contacted", "Converted"], ...days.map((d) => [d.day, d.newLeads, d.contacted, d.converted]), [],
    ["By source"], ["Source", "Leads", "Contacted", "Converted"], ...sources.map((s) => [s.source, s.leads, s.contacted, s.converted]),
  ];
  if (owners.length) {
    rows.push([], ["By team member"], ["Name", "Open leads", "Overdue now", "First contacts", "Attempts logged", "Converted", "Deadlines missed", "Avg hours to first contact"],
      ...owners.map((o) => [o.name, o.open, o.overdue, o.firstContacted, o.attempts, o.converted, o.missed, o.avgFirstContactHrs == null ? "" : o.avgFirstContactHrs.toFixed(1)]));
  }
  return new NextResponse(toCsv(rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="leadflow-insights-${f.period}.csv"`, "cache-control": "no-store" },
  });
}
