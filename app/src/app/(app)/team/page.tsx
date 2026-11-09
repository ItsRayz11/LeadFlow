import Link from "next/link";
import { LeadLink } from "@/components/LeadLink";
import { notFound } from "next/navigation";
import { and, desc, eq, isNull, gt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { canManage, requireCtx } from "@/lib/session";
import { missedHistory, ownerStats } from "@/lib/followups";
import { sweepSoon } from "@/lib/sweep";
import { ActionForm, Submit } from "@/components/ActionForm";
import { aliasAction, aliasDeleteAction, deactivateAction, inviteAction, reactivateAction, revokeInviteAction, setRoleAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const c = await requireCtx();
  if (!canManage(c)) notFound();
  sweepSoon(c.workspaceId);
  const isAdmin = c.role === "admin";
  const [stats, missed, members, invites, aliases, overdue] = await Promise.all([
    ownerStats(c), missedHistory(c),
    db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.workspaceId, c.workspaceId)).orderBy(schema.workspaceMember.displayName),
    isAdmin ? db.select().from(schema.invite).where(and(eq(schema.invite.workspaceId, c.workspaceId), isNull(schema.invite.acceptedAt), isNull(schema.invite.revokedAt), gt(schema.invite.expiresAt, new Date()))).orderBy(desc(schema.invite.createdAt)) : [],
    db.select().from(schema.identityAlias).where(eq(schema.identityAlias.workspaceId, c.workspaceId)).orderBy(schema.identityAlias.alias),
    db.select({ id: schema.lead.id, name: schema.lead.name, owner: schema.workspaceMember.displayName, due: schema.followUpTask.dueAt, esc: schema.followUpTask.escalatedAt })
      .from(schema.followUpTask).innerJoin(schema.lead, eq(schema.lead.id, schema.followUpTask.leadId))
      .leftJoin(schema.workspaceMember, eq(schema.workspaceMember.id, schema.followUpTask.ownerId))
      .where(and(eq(schema.followUpTask.workspaceId, c.workspaceId), eq(schema.followUpTask.status, "pending"), isNull(schema.lead.closedAt), sql`${schema.followUpTask.dueAt} < now()`))
      .orderBy(schema.followUpTask.dueAt).limit(25),
  ]);
  const missedBy = new Map(missed.map((m) => [m.ownerId, m.missed]));
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const activeMembers = members.filter((m) => m.active);
  const rel = (d: Date) => { const h = (Date.now() - d.getTime()) / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };

  return (
    <>
      <header className="top"><div><h1>Team</h1><p>Workload, missed deadlines and access.</p></div></header>

      <section className="panel glass">
        <h2>Workload</h2>
        <div className="tblwrap"><table>
          <thead><tr><th>Member</th><th>Role</th><th>Open leads</th><th>Open tasks</th><th>Due today</th><th>Overdue</th><th>Escalated</th><th>Missed ever</th></tr></thead>
          <tbody>{stats.map((s) => (
            <tr key={s.memberId} style={{ cursor: "default", opacity: s.active ? 1 : 0.55 }}>
              <td><b>{s.name}</b>{!s.active && <span className="pill mute" style={{ marginLeft: 6 }}>inactive</span>}</td><td>{s.role}</td>
              <td className="num">{s.open}</td><td className="num">{s.pending}</td><td className="num">{s.dueToday}</td>
              <td className="num"><Link href={`/followups?view=overdue&owner=${s.memberId}`} style={{ color: s.overdue ? "var(--crit)" : "inherit" }}>{s.overdue}</Link></td>
              <td className="num">{s.escalated}</td><td className="num">{missedBy.get(s.memberId) ?? 0}</td>
            </tr>))}</tbody>
        </table></div>
      </section>

      <section className="panel glass">
        <div className="panel-head"><h2>Overdue leads</h2><Link className="chip" href="/followups?view=overdue">Open queue</Link></div>
        {overdue.length === 0 ? <div className="empty">No overdue follow-ups.</div> : (
          <div className="queue">{overdue.map((o) => (
            <LeadLink key={o.id} id={o.id} className="lead overdue" style={{ color: "inherit", textDecoration: "none" }}>
              <div className="lead-top"><div><b>{o.name}</b><div className="sub">Owner: {o.owner ?? "Unassigned"}</div></div>
                <span><span className="pill crit">{rel(o.due)} overdue</span>{o.esc && <span className="pill crit" style={{ marginLeft: 4 }}>escalated</span>}</span></div>
            </LeadLink>))}</div>
        )}
      </section>

      <div className="grid2">
        <section className="panel glass">
          <h2>Members</h2>
          {members.map((m) => (
            <div key={m.id} className="lead" style={{ opacity: m.active ? 1 : 0.65 }}>
              <div className="lead-top"><div><b>{m.displayName}</b><div className="sub">{m.active ? "Active" : "Deactivated"}</div></div>
                {isAdmin && m.active ? (
                  <ActionForm action={setRoleAction} className="acts">
                    <input type="hidden" name="memberId" value={m.id} />
                    <select name="role" defaultValue={m.role} aria-label={`Role for ${m.displayName}`}>{["admin", "manager", "bd", "viewer"].map((r) => <option key={r}>{r}</option>)}</select>
                    <Submit className="chip" pendingText="Saving">Set</Submit>
                  </ActionForm>
                ) : <span className="pill acc">{m.role}</span>}
              </div>
              {isAdmin && m.active && m.id !== c.memberId && (
                <ActionForm action={deactivateAction} className="acts">
                  <input type="hidden" name="memberId" value={m.id} />
                  <select name="reassignTo" aria-label={`Hand ${m.displayName}'s open leads to`} defaultValue="">
                    <option value="">Leave their leads unassigned</option>
                    {activeMembers.filter((x) => x.id !== m.id && x.role !== "viewer").map((x) => <option key={x.id} value={x.id}>Hand leads to {x.displayName}</option>)}
                  </select>
                  <Submit className="chip" pendingText="Working">Deactivate</Submit>
                </ActionForm>
              )}
              {isAdmin && !m.active && (
                <ActionForm action={reactivateAction}><input type="hidden" name="memberId" value={m.id} /><Submit className="chip">Reactivate</Submit></ActionForm>
              )}
            </div>))}
        </section>

        {isAdmin && (
          <section className="panel glass">
            <h2>Invite a team member</h2>
            <ActionForm action={inviteAction} resetOnOk className="panel">
              <label className="field"><span>Name</span><input type="text" name="displayName" required maxLength={80} /></label>
              <label className="field"><span>Email</span><input type="text" inputMode="email" name="email" required /></label>
              <label className="field"><span>Role</span><select name="role" defaultValue="bd"><option value="bd">BD (own leads only)</option><option value="manager">Manager</option><option value="viewer">Read-only</option><option value="admin">Admin</option></select></label>
              <Submit>Create invitation</Submit>
            </ActionForm>
            <p className="sub">The link works once, only for that email, and expires in 7 days. No email is sent. Share the link yourself.</p>
            {invites.map((i) => (
              <div key={i.id} className="lead"><div className="lead-top"><div><b>{i.displayName}</b><div className="sub">{i.email} · {i.role} · expires {i.expiresAt.toLocaleDateString([], { timeZone: c.tz })}</div></div>
                <ActionForm action={revokeInviteAction}><input type="hidden" name="id" value={i.id} /><Submit className="chip" pendingText="Revoking">Revoke</Submit></ActionForm></div></div>))}
          </section>
        )}
      </div>

      {isAdmin && (
        <section className="panel glass">
          <h2>Names in the spreadsheet</h2>
          <p className="sub">Map each name found in the sheet to a person here. Nothing is guessed: two similar names stay separate until you map them. Unmapped names import as unassigned.</p>
          <ActionForm action={aliasAction} resetOnOk className="acts">
            <input type="text" name="alias" placeholder="Name as in the sheet" required maxLength={80} aria-label="Name as in the sheet" />
            <select name="memberId" aria-label="Person" defaultValue=""><option value="">Not a team member (unmapped)</option>{activeMembers.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>
            <Submit className="chip primary" pendingText="Saving">Save mapping</Submit>
          </ActionForm>
          {aliases.length === 0 ? <div className="empty">No names mapped yet. Add Fazal, Bawar, Badar and anyone else you see in the sheet.</div> : aliases.map((a) => (
            <div key={a.id} className="set-row"><span><b>{a.alias}</b> → {a.memberId ? nameOf.get(a.memberId) ?? "removed member" : <i>unmapped</i>}</span>
              <ActionForm action={aliasDeleteAction}><input type="hidden" name="id" value={a.id} /><Submit className="chip" pendingText="Removing">Remove</Submit></ActionForm></div>))}
        </section>
      )}
    </>
  );
}
