"use client";
import { LeadLink } from "@/components/LeadLink";
import { useMemo, useState } from "react";
import { ActionForm, Submit } from "@/components/ActionForm";
import { AssignControl, QuickActions, RescheduleButton } from "@/components/FollowUpActions";
import { bulkAction } from "@/app/(app)/actions";

export type TaskRowDTO = {
  leadId: string; name: string; phone: string | null; source: string | null; ownerId: string | null; owner: string | null;
  step: string | null; leadStep: string; dueAt: string | null; attempts: number; taskAttempts: number | null;
  missedAt: string | null; escalatedAt: string | null; priority: string; lastResult: string | null;
};
export type DoneRowDTO = { leadId: string; name: string; owner: string | null; step: string; outcome: string | null; channel: string | null; completedAt: string | null; notes: string | null };

const STEP: Record<string, string> = { contact_started: "First contact", h24: "Follow-up", h48: "48H follow-up", final: "Final follow-up", completed: "Sequence complete" };
const OUT: Record<string, string> = { reached: "Spoke to lead", no_answer: "No answer", interested: "Interested", callback_requested: "Callback requested", converted: "Converted", not_interested: "Not interested", dropped: "Dropped" };

function rel(iso: string | null, now: number) {
  if (!iso) return "No follow-up";
  const diff = new Date(iso).getTime() - now, a = Math.abs(diff) / 36e5;
  const s = a < 1 ? `${Math.max(1, Math.round(a * 60))} min` : a < 48 ? `${Math.round(a)} h` : `${Math.round(a / 24)} d`;
  return diff < 0 ? `${s} overdue` : `in ${s}`;
}
const tone = (iso: string | null, now: number) => (!iso ? "" : new Date(iso).getTime() < now ? "crit" : new Date(iso).getTime() - now < 30 * 60000 ? "warn" : "acc");

function Due({ r, now }: { r: TaskRowDTO; now: number }) {
  return (
    <span suppressHydrationWarning>
      <span className={`pill ${tone(r.dueAt, now) || (r.leadStep === "completed" ? "warn" : "")}`}>{r.dueAt ? rel(r.dueAt, now) : r.leadStep === "completed" ? "Decide outcome" : "No follow-up"}</span>
      {r.missedAt && <span className="pill mute minipill" title="A deadline was missed">missed</span>}
      {r.escalatedAt && <span className="pill crit minipill" title="Escalated to managers">escalated</span>}
    </span>
  );
}

export function TaskList({ rows, owners, canManage, canWrite, selfId }: {
  rows: TaskRowDTO[]; owners: { id: string; name: string }[]; canManage: boolean; canWrite: boolean; selfId: string;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const now = useMemo(() => Date.now(), []);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const all = sel.length === rows.length && rows.length > 0;
  const canAct = (r: TaskRowDTO) => canWrite && (canManage || r.ownerId === selfId);

  if (!rows.length) return <div className="empty">Nothing here. New tasks appear when follow-ups come due.</div>;

  return (
    <>
      <div className="tbl"><div className="tblwrap dtbl"><table>
        <thead><tr>
          {canManage && <th style={{ width: 30 }}><input className="chk" type="checkbox" aria-label="Select all" checked={all} onChange={() => setSel(all ? [] : rows.map((r) => r.leadId))} /></th>}
          <th>Lead</th><th>Owner</th><th>Step</th><th>Due</th><th>Tries</th><th>Actions</th>
        </tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.leadId} className={r.dueAt && new Date(r.dueAt).getTime() < now ? "tr-over" : ""} style={{ cursor: "default" }}>
            {canManage && <td><input className="chk" type="checkbox" aria-label={`Select ${r.name}`} checked={sel.includes(r.leadId)} onChange={() => toggle(r.leadId)} /></td>}
            <td><LeadLink id={r.leadId} style={{ color: "inherit", textDecoration: "none" }}><b>{r.name}</b><div className="sub num">{r.phone}</div></LeadLink></td>
            <td>{canManage ? <AssignControl leadId={r.leadId} ownerId={r.ownerId} owners={owners} /> : r.owner ?? <span className="pill crit">Unassigned</span>}</td>
            <td className="wrap">{STEP[r.step ?? r.leadStep]}</td>
            <td><Due r={r} now={now} /></td>
            <td className="num">{r.attempts}</td>
            <td>{canAct(r) ? <div className="acts"><QuickActions leadId={r.leadId} name={r.name} phone={r.phone} compact /><RescheduleButton leadId={r.leadId} name={r.name} compact /></div> : <span className="sub">View only</span>}</td>
          </tr>))}</tbody>
      </table></div></div>

      <div className="cards m">{rows.map((r) => (
        <article key={r.leadId} className={`lead ${r.dueAt && new Date(r.dueAt).getTime() < now ? "overdue" : ""}`}>
          <div className="lead-top">
            <LeadLink id={r.leadId} style={{ color: "inherit", textDecoration: "none" }}><b>{r.name}</b><div className="sub">{STEP[r.step ?? r.leadStep]} · {r.owner ?? "Unassigned"}</div></LeadLink>
            <Due r={r} now={now} />
          </div>
          {canAct(r) && <div className="acts"><QuickActions leadId={r.leadId} name={r.name} phone={r.phone} /><RescheduleButton leadId={r.leadId} name={r.name} /></div>}
          {canManage && <AssignControl leadId={r.leadId} ownerId={r.ownerId} owners={owners} />}
        </article>))}
      </div>

      {canManage && sel.length > 0 && (
        <div className="bulkbar glass" role="region" aria-label="Bulk actions">
          <b>{sel.length} selected</b>
          <ActionForm action={bulkAction} className="acts" onOk={() => setSel([])}>
            <input type="hidden" name="kind" value="assign" /><input type="hidden" name="ids" value={sel.join(",")} />
            <select name="ownerId" aria-label="Assign selected to"><option value="">Unassigned</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
            <Submit className="chip primary" pendingText="Assigning">Assign</Submit>
          </ActionForm>
          <ActionForm action={bulkAction} className="acts" onOk={() => setSel([])}>
            <input type="hidden" name="kind" value="reschedule" /><input type="hidden" name="ids" value={sel.join(",")} />
            <select name="hours" aria-label="Reschedule selected by" defaultValue="24"><option value="4">+4 h</option><option value="24">+24 h</option><option value="48">+48 h</option></select>
            <Submit className="chip" pendingText="Rescheduling">Reschedule</Submit>
          </ActionForm>
          <button type="button" className="chip" onClick={() => setSel([])}>Clear</button>
        </div>
      )}
    </>
  );
}

export function DoneList({ rows }: { rows: DoneRowDTO[] }) {
  if (!rows.length) return <div className="empty">Nothing completed yet. Log a result and it appears here.</div>;
  return (
    <div className="queue">{rows.map((r, i) => (
      <article key={i} className="lead">
        <div className="lead-top">
          <LeadLink id={r.leadId} style={{ color: "inherit", textDecoration: "none" }}><b>{r.name}</b><div className="sub">{STEP[r.step]} · {r.owner ?? "Unassigned"} · {r.channel ?? "n/a"}</div></LeadLink>
          <span className="pill ok">{OUT[r.outcome ?? ""] ?? "Done"}</span>
        </div>
        {r.notes && <p className="sub" style={{ margin: 0 }}>{r.notes}</p>}
        <div className="sub" suppressHydrationWarning>{r.completedAt ? new Date(r.completedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</div>
      </article>))}
    </div>
  );
}
