import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { canManage, canWrite, requireCtx } from "@/lib/session";
import { scope } from "@/lib/leads";
import { ActionForm, Submit } from "@/components/ActionForm";
import { AssignControl, QuickActions } from "@/components/FollowUpActions";
import { closeAction, completeFollowUpAction, logOutcomeAction, milestoneAction, noteAction, reopenAction, setFollowUpDateAction, updateLeadAction } from "@/app/(app)/actions";
import { dayKey, readSettings } from "@/lib/schedule";

const MS = [
  ["appDownloadedAt", "App downloaded"], ["referralSharedAt", "Referral shared"], ["cardPurchasedAt", "Card purchased"], ["spendingStartedAt", "Spending started"],
] as const;
const STATUS = [["new", "New"], ["contacted", "Contacted"], ["interested", "Interested"], ["proposal_sent", "Proposal sent"], ["cold", "Cold"]] as const;
const OUTCOMES = [["converted", "Converted"], ["not_interested", "Not interested"], ["no_response", "No response"], ["dropped", "Dropped"], ["duplicate", "Duplicate"], ["invalid", "Invalid lead"], ["other", "Other"]] as const;
const STEP: Record<string, string> = { contact_started: "First contact", h24: "Follow-up", h48: "Follow-up (2nd stage)", final: "Follow-up (final stage)", completed: "Complete" };

/** The lead detail, shared by the full page and the pop-up. The pop-up has its own close button, so it hides "Back to leads". */
export async function LeadView({ id, modal = false }: { id: string; modal?: boolean }) {
  const c = await requireCtx();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [l] = await db.select().from(schema.lead).where(and(scope(c), eq(schema.lead.id, id))).limit(1);
  if (!l) notFound();

  const [wsRow] = await db.select({ settings: schema.workspace.settings }).from(schema.workspace).where(eq(schema.workspace.id, c.workspaceId));
  const [owner, acts, tasks, owners, people] = await Promise.all([
    l.ownerId ? db.select({ n: schema.workspaceMember.displayName }).from(schema.workspaceMember).where(eq(schema.workspaceMember.id, l.ownerId)).then((r) => r[0]) : undefined,
    db.select().from(schema.leadActivity).where(eq(schema.leadActivity.leadId, l.id)).orderBy(desc(schema.leadActivity.occurredAt)).limit(500),
    db.select().from(schema.followUpTask).where(eq(schema.followUpTask.leadId, l.id)).orderBy(desc(schema.followUpTask.createdAt)).limit(30),
    db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName }).from(schema.workspaceMember)
      .where(and(eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true))),
    db.select({ uid: schema.workspaceMember.userId, name: schema.workspaceMember.displayName }).from(schema.workspaceMember).where(eq(schema.workspaceMember.workspaceId, c.workspaceId)),
  ]);
  const who = new Map(people.map((p) => [p.uid, p.name]));
  const write = canWrite(c) && (canManage(c) || l.ownerId === c.memberId);
  const mgr = canManage(c);
  const fmt = (d: Date) => d.toLocaleString([], { timeZone: c.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const pending = tasks.find((t) => t.status === "pending");
  const overdue = !!pending && pending.dueAt.getTime() < Date.now();
  const lastDone = tasks.find((t) => t.status === "completed" && t.completedAt);
  // Before the first confirmed contact the only task is the pending first-contact one; it is not a follow-up, so it is not listed as history.
  const fuHist = tasks.filter((t) => t.step !== "contact_started" || t.status !== "pending");
  const days = readSettings(wsRow?.settings).followUpDays;
  const today = dayKey(new Date(), c.tz);
  const day = (d: Date) => d.toLocaleDateString([], { timeZone: c.tz, day: "numeric", month: "short", year: "numeric" });
  const fu = l.closedAt ? { label: "Closed", tone: "ok" }
    : !l.firstContactedAt ? { label: "First contact pending", tone: "warn" }
    : !pending ? { label: "No follow-up scheduled", tone: "warn" }
    : overdue ? { label: "Follow-up overdue", tone: "crit" } : { label: "Follow-up pending", tone: "acc" };
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
          {l.closedAt ? <span className="pill ok">Closed: {l.outcome?.replace("_", " ")}</span> : <span className={`pill ${fu.tone}`}>{fu.label}</span>}
          {!l.closedAt && !l.firstContactedAt && overdue && <span className="pill crit" style={{ marginLeft: 4 }}>Overdue</span>}
          {pending?.firstMissedAt && <span className="pill mute" style={{ marginLeft: 4 }}>deadline missed</span>}
        </div>
        <dl className="kv">
          <dt>Owner</dt><dd>{mgr ? <AssignControl leadId={l.id} ownerId={l.ownerId} owners={owners} /> : owner?.n ?? "Unassigned"}</dd>
          <dt>Next follow-up</dt><dd>{l.closedAt ? "None (closed)" : !l.firstContactedAt ? "First contact pending" : pending ? <b>{day(pending.dueAt)}{pending.dateSource === "manual" ? " · set by hand" : ""}</b> : "Not scheduled"}</dd>
          <dt>Last follow-up</dt><dd>{lastDone ? `Done ${fmt(lastDone.completedAt!)} by ${who.get(lastDone.completedBy ?? "") ?? "a teammate"}` : "None yet"}</dd>
          <dt>First contact</dt><dd>{l.firstContactedAt ? fmt(l.firstContactedAt) : "Pending"}</dd>
          <dt>Phone</dt><dd className="num">{l.phoneRaw ?? "None"}</dd>
          <dt>Email</dt><dd>{l.email ?? "None"}</dd>
          <dt>Acquired</dt><dd>{fmt(l.acquiredAt)}</dd>
          {l.closureReason && <><dt>Closure reason</dt><dd>{l.closureReason}</dd></>}
        </dl>
      </section>

      {write && !l.closedAt && (
        <section className="panel glass fu-card" aria-label="Follow-up">
          <h2>Follow-up</h2>
          {!l.firstContactedAt ? (
            <ActionForm action={logOutcomeAction} className="panel">
              {hid}<input type="hidden" name="outcome" value="reached" />
              <p className="sub">Nobody has reached this lead yet. Confirm the first contact once it really happened. The first follow-up is then scheduled {days} days later.</p>
              <label className="field"><span>How did you reach them?</span>
                <select name="channel" defaultValue="call">{[["call", "Call"], ["whatsapp", "WhatsApp"], ["email", "Email"], ["sms", "SMS"], ["other", "Other"]].map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
              <label className="field"><span>Note (optional)</span><textarea name="notes" maxLength={2000} /></label>
              <Submit className="btn fu-main">Confirm first contact</Submit>
            </ActionForm>
          ) : pending ? (
            <ActionForm action={completeFollowUpAction} className="panel">
              {hid}
              <p className="sub">{overdue ? "This follow-up is overdue. " : ""}When it is done, the next one is scheduled {days} days from now, or on the date you choose.</p>
              <label className="field"><span>Note (optional)</span><textarea name="notes" maxLength={2000} /></label>
              <label className="field"><span>Next follow-up date (optional)</span><input type="date" name="nextDate" min={today} /></label>
              <Submit className="btn fu-main">Mark Follow-up Done</Submit>
            </ActionForm>
          ) : (
            <p className="sub">No follow-up is scheduled. Pick a date below.</p>
          )}
          <div className="acts fu-other"><QuickActions leadId={l.id} name={l.name} phone={l.phoneRaw} logOnly /><span className="sub">For no answer, callbacks and closing results.</span></div>
          <ActionForm action={setFollowUpDateAction} className="fu-date">
            {hid}
            <label className="field"><span>{pending ? "Change the next follow-up date" : "Schedule a follow-up"}</span><input type="date" name="date" min={today} required defaultValue={pending ? dayKey(pending.dueAt, c.tz) : ""} /></label>
            <Submit className="chip">Save date</Submit>
          </ActionForm>
        </section>
      )}

      {fuHist.length > 0 && (
        <section className="panel glass">
          <h2>Follow-up history</h2>
          <ul className="tl">{fuHist.map((t) => {
            const st = t.status === "completed" ? "Done" : t.status === "pending" ? (t.dueAt.getTime() < Date.now() ? "Overdue" : "Pending") : t.status === "rescheduled" ? "Rescheduled" : "Cancelled";
            return (
              <li key={t.id}><div>
                <span className={`pill ${st === "Done" ? "ok" : st === "Overdue" ? "crit" : st === "Pending" ? "warn" : "mute"}`}>{st}</span>{" "}
                {STEP[t.step]} · due {day(t.dueAt)}
                <div className="t">{t.status === "completed" ? `Done ${fmt(t.completedAt!)} by ${who.get(t.completedBy ?? "") ?? "a teammate"}` : t.dateSource === "manual" ? "Date set by hand" : "Scheduled automatically"}{t.notes ? ` · ${t.notes}` : ""}</div>
              </div></li>
            );
          })}</ul>
        </section>
      )}

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
          <li key={a.id}><div className="act-body">
            {(a.data as { source?: string } | null)?.source === "google_sheets" && <span className="pill mute minipill">Google Sheets</span>}{" "}
            {(a.data as { source?: string } | null)?.source === "google_sheets" ? ((a.data as { text?: string }).text ?? a.summary) : (a.summary ?? a.type)}
            <div className="t">{a.actorId ? (who.get(a.actorId) ? `${who.get(a.actorId)} · ` : "") : "System · "}{fmt(a.occurredAt)}{a.channel ? ` · ${a.channel}` : ""}</div></div></li>
        ))}</ul>
      </section>
    </>
  );
}
