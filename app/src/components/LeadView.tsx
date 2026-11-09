import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { canManage, canWrite, requireCtx } from "@/lib/session";
import { relTime, scope } from "@/lib/leads";
import { ActionForm, Submit } from "@/components/ActionForm";
import { AssignControl, QuickActions, RescheduleButton } from "@/components/FollowUpActions";
import { closeAction, milestoneAction, noteAction, reopenAction, updateLeadAction } from "@/app/(app)/actions";

const MS = [
  ["appDownloadedAt", "App downloaded"], ["referralSharedAt", "Referral shared"], ["cardPurchasedAt", "Card purchased"], ["spendingStartedAt", "Spending started"],
] as const;
const STATUS = [["new", "New"], ["contacted", "Contacted"], ["interested", "Interested"], ["proposal_sent", "Proposal sent"], ["cold", "Cold"]] as const;
const OUTCOMES = [["converted", "Converted"], ["not_interested", "Not interested"], ["no_response", "No response"], ["dropped", "Dropped"], ["duplicate", "Duplicate"], ["invalid", "Invalid lead"], ["other", "Other"]] as const;
const STEP: Record<string, string> = { contact_started: "First contact", h24: "24H follow-up", h48: "48H follow-up", final: "Final follow-up", completed: "Sequence complete" };

/** The lead detail, shared by the full page and the pop-up. The pop-up has its own close button, so it hides "Back to leads". */
export async function LeadView({ id, modal = false }: { id: string; modal?: boolean }) {
  const c = await requireCtx();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [l] = await db.select().from(schema.lead).where(and(scope(c), eq(schema.lead.id, id))).limit(1);
  if (!l) notFound();

  const [owner, acts, tasks, owners] = await Promise.all([
    l.ownerId ? db.select({ n: schema.workspaceMember.displayName }).from(schema.workspaceMember).where(eq(schema.workspaceMember.id, l.ownerId)).then((r) => r[0]) : undefined,
    db.select().from(schema.leadActivity).where(eq(schema.leadActivity.leadId, l.id)).orderBy(desc(schema.leadActivity.occurredAt)).limit(100),
    db.select().from(schema.followUpTask).where(eq(schema.followUpTask.leadId, l.id)).orderBy(desc(schema.followUpTask.createdAt)).limit(30),
    db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName }).from(schema.workspaceMember)
      .where(and(eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true))),
  ]);
  const write = canWrite(c) && (canManage(c) || l.ownerId === c.memberId);
  const mgr = canManage(c);
  const fmt = (d: Date) => d.toLocaleString([], { timeZone: c.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const pending = tasks.find((t) => t.status === "pending");
  const hid = <input type="hidden" name="leadId" value={l.id} />;

  return (
    <>
      <header className="top">
        <div><h1>{l.name}</h1><p className="num">{l.phoneRaw ?? "No phone"} · {l.source ?? "No source"}</p></div>
        {!modal && <Link className="chip" href="/leads">Back to leads</Link>}
      </header>

      <section className="panel glass">
        <div>
          <span className="pill acc">{l.status.replace("_", " ")}</span>{" "}
          {l.closedAt ? <span className="pill ok">Closed: {l.outcome?.replace("_", " ")}</span>
            : pending ? <span className={`pill ${pending.dueAt.getTime() < Date.now() ? "crit" : "warn"}`}>{STEP[pending.step]} · {relTime(pending.dueAt)}</span>
            : <span className="pill warn">{l.followUpStep === "completed" ? "Decide outcome" : "No follow-up scheduled"}</span>}
          {pending?.firstMissedAt && <span className="pill mute" style={{ marginLeft: 4 }}>deadline missed</span>}
        </div>
        {write && !l.closedAt && <QuickActions leadId={l.id} name={l.name} phone={l.phoneRaw} />}
        {write && !l.closedAt && <div className="acts"><RescheduleButton leadId={l.id} name={l.name} /></div>}
        <dl className="kv">
          <dt>Owner</dt><dd>{mgr ? <AssignControl leadId={l.id} ownerId={l.ownerId} owners={owners} /> : owner?.n ?? "Unassigned"}</dd>
          <dt>Acquired</dt><dd>{fmt(l.acquiredAt)}</dd>
          <dt>Imported</dt><dd>{fmt(l.importedAt)}</dd>
          <dt>Attempts</dt><dd>{l.followUpAttempts}</dd>
          <dt>First contact</dt><dd>{l.firstContactedAt ? fmt(l.firstContactedAt) : "Not yet"}</dd>
          <dt>Last contact</dt><dd>{l.lastContactedAt ? fmt(l.lastContactedAt) : "Not yet"}</dd>
          <dt>Last result</dt><dd>{l.lastResult?.replace("_", " ") ?? "None"}</dd>
          <dt>Email</dt><dd>{l.email ?? "None"}</dd>
          {l.closureReason && <><dt>Closure reason</dt><dd>{l.closureReason}</dd></>}
        </dl>
      </section>

      <section className="panel glass">
        <h2>Activation</h2>
        <div className="acts">{MS.map(([k, label]) => {
          const on = Boolean(l[k]);
          return write ? (
            <ActionForm key={k} action={milestoneAction}>
              {hid}<input type="hidden" name="milestone" value={k} /><input type="hidden" name="on" value={on ? "0" : "1"} />
              <button className={`mbtn ${on ? "on" : ""}`} aria-pressed={on}>{label}{on ? " ✓" : ""}</button>
            </ActionForm>
          ) : <span key={k} className={`pill ${on ? "ok" : ""}`}>{label}{on ? "" : " (not yet)"}</span>;
        })}</div>
      </section>

      {write && (
        <section className="panel glass">
          <h2>Details</h2>
          <ActionForm action={updateLeadAction} className="panel">
            {hid}
            <div className="grid2" style={{ gap: 10 }}>
              <label className="field"><span>Name</span><input type="text" name="name" defaultValue={l.name} /></label>
              <label className="field"><span>Phone</span><input type="text" name="phone" defaultValue={l.phoneRaw ?? ""} /></label>
              <label className="field"><span>Email</span><input type="text" name="email" defaultValue={l.email ?? ""} /></label>
              <label className="field"><span>Source</span><input type="text" name="source" defaultValue={l.source ?? ""} /></label>
              <label className="field"><span>Campaign</span><input type="text" name="campaign" defaultValue={l.campaign ?? ""} /></label>
              <label className="field"><span>Priority</span><select name="priority" defaultValue={l.priority}>{["low", "normal", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}</select></label>
              {!l.closedAt && <label className="field"><span>Stage</span><select name="status" defaultValue={l.status}>{STATUS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>}
            </div>
            <Submit>Save changes</Submit>
          </ActionForm>
        </section>
      )}

      {write && (
        <section className="panel glass">
          <h2>{l.closedAt ? "Reopen" : "Close lead"}</h2>
          {l.closedAt ? (
            <ActionForm action={reopenAction}>{hid}<Submit className="chip primary">Reopen lead</Submit></ActionForm>
          ) : (
            <ActionForm action={closeAction} className="acts">
              {hid}
              <select name="outcome" aria-label="Outcome" required defaultValue="">{<option value="" disabled>Outcome</option>}{OUTCOMES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
              <input type="text" name="reason" placeholder="Reason (optional)" maxLength={500} style={{ flex: 1, minWidth: 160 }} aria-label="Reason" />
              <Submit className="chip" pendingText="Closing">Close lead</Submit>
            </ActionForm>
          )}
        </section>
      )}

      <section className="panel glass">
        <h2>Activity</h2>
        {write && (
          <ActionForm action={noteAction} resetOnOk className="panel">
            {hid}
            <label className="field"><span>Add a note</span><textarea name="text" maxLength={2000} required /></label>
            <Submit className="chip primary">Save note</Submit>
          </ActionForm>
        )}
        <ul className="tl">{acts.map((a) => (
          <li key={a.id}><div>{a.summary ?? a.type}<div className="t">{a.actorId ? "" : "System · "}{fmt(a.occurredAt)}{a.channel ? ` · ${a.channel}` : ""}</div></div></li>
        ))}</ul>
      </section>
    </>
  );
}
