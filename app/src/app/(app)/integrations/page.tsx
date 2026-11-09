import { and, desc, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { canManage, requireCtx } from "@/lib/session";
import { ActionForm, Submit } from "@/components/ActionForm";
import { aliasAction, confirmMappingAction, connectSheetAction, syncNowAction } from "./actions";

export const dynamic = "force-dynamic";
// Server actions on this page (import, sync) inherit this limit.
export const maxDuration = 60;

const fmt = (d: Date | null, tz: string) => (d ? d.toLocaleString([], { timeZone: tz }) : "Never");

export default async function IntegrationsPage() {
  const c = await requireCtx();
  if (!canManage(c)) notFound();
  const conns = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.workspaceId, c.workspaceId));
  const members = await db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName, role: schema.workspaceMember.role })
    .from(schema.workspaceMember).where(and(eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true)));
  const conflicts = await db.select({ v: schema.syncConflict.sheetValue }).from(schema.syncConflict)
    .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.syncConflict.connectionId))
    .where(and(eq(schema.spreadsheetConnection.workspaceId, c.workspaceId), isNull(schema.syncConflict.resolvedAt), eq(schema.syncConflict.field, "unmapped_owner")));
  const assignable = members.filter((m) => m.role !== "viewer");
  const aliases = [...new Set(conflicts.map((x) => x.v ?? "").filter(Boolean))];

  const cards = await Promise.all(conns.map(async (cn) => ({
    cn,
    maps: await db.select().from(schema.worksheetMapping).where(eq(schema.worksheetMapping.connectionId, cn.id)),
    jobs: await db.select().from(schema.syncJob).where(eq(schema.syncJob.connectionId, cn.id)).orderBy(desc(schema.syncJob.startedAt)).limit(8),
  })));

  return (
    <>
      <header className="top"><div><h1>Integrations</h1><p>Google Sheets feeds new leads in. The sheet is never written to, and leads are never deleted when a row disappears.</p></div></header>

      {cards.map(({ cn, maps, jobs }) => (
        <section key={cn.id} className="panel glass">
          <h2>{cn.title ?? "Google Sheet"} {cn.healthy ? <span className="pill ok">Healthy</span> : <span className="pill crit">Needs attention</span>}</h2>
          <dl className="kv" style={{ gridTemplateColumns: "190px 1fr" }}>
            <dt>Mode</dt><dd>Read-only import</dd>
            <dt>Last successful sync</dt><dd>{fmt(cn.lastSuccessfulSyncAt, c.tz)}</dd>
            <dt>Access</dt><dd>Link sharing, view only. Google sign-in replaces this once credentials are added.</dd>
            {cn.lastError && <><dt>Last error</dt><dd className="err">{cn.lastError}</dd></>}
          </dl>
          {maps.map((m) => {
            const cm = m.columnMap as { externalId?: string; contact?: string[] };
            return (
              <div key={m.id} style={{ marginTop: 12 }}>
                <h3>Worksheet {m.sheetGid} {m.confirmedAt ? <span className="pill ok">Mapped</span> : <span className="pill warn">Not confirmed</span>}</h3>
                <p className="sub">Lead identity: the “{cm.externalId}” column, never the row number. Phone and email are read from every column named {(cm.contact ?? []).join(", ")}.</p>
                {!m.confirmedAt && (
                  <ActionForm action={confirmMappingAction}><input type="hidden" name="mappingId" value={m.id} /><Submit pendingText="Importing">Confirm mapping and import</Submit></ActionForm>
                )}
              </div>
            );
          })}
          {maps.some((m) => m.confirmedAt) && (
            <ActionForm action={syncNowAction}><input type="hidden" name="connectionId" value={cn.id} /><Submit pendingText="Syncing">Sync now</Submit></ActionForm>
          )}
          <h3 style={{ marginTop: 16 }}>Sync history</h3>
          {jobs.length === 0 ? <p className="sub">No syncs yet.</p> : (
            <ul className="plain">
              {jobs.map((j) => (
                <li key={j.id}>
                  <span className={`pill ${j.status === "success" ? "ok" : j.status === "running" ? "mute" : j.status === "partial" ? "warn" : "crit"}`}>{j.status}</span>{" "}
                  {fmt(j.startedAt, c.tz)} · {j.trigger} · {j.rowsCreated} new, {j.rowsUpdated} updated, {j.rowsSkipped} skipped{j.error ? ` · ${j.error}` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {aliases.length > 0 && (
        <section className="panel glass">
          <h2>Names in the sheet that match nobody</h2>
          <p className="sub">Those leads stayed unassigned. Link each name to a team member and future syncs assign them automatically.</p>
          {aliases.map((alias) => (
            <ActionForm key={alias} action={aliasAction} className="grid2">
              <input type="hidden" name="alias" value={alias} />
              <label className="field"><span>“{alias}” is</span>
                <select name="memberId" required defaultValue="">
                  <option value="" disabled>Choose a person</option>
                  {assignable.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>
              <div><Submit>Link</Submit></div>
            </ActionForm>
          ))}
        </section>
      )}

      <section className="panel glass">
        <h2>Connect a worksheet</h2>
        <ActionForm action={connectSheetAction}>
          <label className="field"><span>Google Sheets link (open the tab and copy the address bar)</span>
            <input type="url" name="url" placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=…" required /></label>
          <Submit pendingText="Checking">Connect</Submit>
        </ActionForm>
      </section>
    </>
  );
}
