import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { canManage, canWrite, requireCtx } from "@/lib/session";
import { VIEWS, listCompleted, listFollowUps, ownerStats, viewCounts, type View } from "@/lib/followups";
import { sweepSoon } from "@/lib/sweep";
import { DoneList, TaskList, type DoneRowDTO, type TaskRowDTO } from "@/components/TaskList";

export const dynamic = "force-dynamic";
type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function FollowUps({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await requireCtx();
  sweepSoon(c.workspaceId);
  const sp = await searchParams;
  const mgr = canManage(c);
  const views = VIEWS.filter((v) => !v.manager || mgr).filter((v) => !(c.role === "bd" && v.key === "unassigned"));
  const view = (views.find((v) => v.key === one(sp.view))?.key ?? (mgr ? "overdue" : "mine")) as View;
  const q = one(sp.q), sort = one(sp.sort), ownerId = mgr ? one(sp.owner) : "";

  const [counts, owners] = await Promise.all([
    viewCounts(c),
    db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName }).from(schema.workspaceMember)
      .where(and(eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true))),
  ]);
  const ownerOpts = owners;

  let body: React.ReactNode;
  if (view === "completed") {
    const rows = await listCompleted(c, { q, ownerId: ownerId || undefined });
    const dto: DoneRowDTO[] = rows.map((r) => ({ ...r, step: r.step, completedAt: r.completedAt?.toISOString() ?? null }));
    body = <DoneList rows={dto} />;
  } else {
    const rows = await listFollowUps(c, { view, q, sort, ownerId: ownerId || undefined });
    const dto: TaskRowDTO[] = rows.map((r) => ({
      leadId: r.leadId, name: r.name, phone: r.phone, source: r.source, ownerId: r.ownerId, owner: r.owner, step: r.step, leadStep: r.leadStep,
      dueAt: r.dueAt?.toISOString() ?? null, attempts: r.attempts, taskAttempts: r.taskAttempts, missedAt: r.missedAt?.toISOString() ?? null,
      escalatedAt: r.escalatedAt?.toISOString() ?? null, priority: r.priority, lastResult: r.lastResult,
    }));
    body = <TaskList rows={dto} owners={ownerOpts} canManage={mgr} canWrite={canWrite(c)} selfId={c.memberId} />;
  }

  const href = (v: string) => `/followups?view=${v}${q ? `&q=${encodeURIComponent(q)}` : ""}${ownerId ? `&owner=${ownerId}` : ""}${sort ? `&sort=${sort}` : ""}`;
  const stats = view === "team" && mgr ? await ownerStats(c) : [];

  return (
    <>
      <header className="top"><div><h1>Follow-ups</h1><p>Overdue tasks stay here until someone resolves them.</p></div></header>
      <section className="panel glass">
        <div className="seg" role="tablist" aria-label="Follow-up views">
          {views.map((v) => (
            <Link key={v.key} href={href(v.key)} className={view === v.key ? "on" : ""} role="tab" aria-selected={view === v.key}>
              {v.label} <span className="c">{counts[v.key]}</span>
            </Link>
          ))}
        </div>
        <form className="filters" action="/followups">
          <input type="hidden" name="view" value={view} />
          <div className="row">
            <label className="field"><span>Search name or phone</span><input type="search" name="q" defaultValue={q} placeholder="Search" /></label>
            {mgr && <label className="field"><span>Owner</span><select name="owner" defaultValue={ownerId}><option value="">Everyone</option>{ownerOpts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
            <label className="field"><span>Sort</span><select name="sort" defaultValue={sort}><option value="">Due soonest</option><option value="-due">Due latest</option><option value="name">Name</option>{mgr && <option value="owner">Owner</option>}</select></label>
          </div>
          <button className="chip" style={{ justifySelf: "start" }}>Apply</button>
        </form>

        {stats.length > 0 && (
          <div className="stat-grid">{stats.filter((s) => s.active).map((s) => (
            <Link key={s.memberId} href={href("overdue") + `&owner=${s.memberId}`} className="stat" style={{ textDecoration: "none", color: "inherit" }}>
              <span className="label">{s.name}</span><span className="v num" style={{ color: s.overdue ? "var(--crit)" : undefined }}>{s.overdue}</span><span className="d">overdue · {s.pending} open</span>
            </Link>))}</div>
        )}
        {body}
      </section>
    </>
  );
}
