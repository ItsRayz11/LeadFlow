import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { canManage, requireCtx } from "@/lib/session";
import { ActionForm, Submit } from "@/components/ActionForm";
import { serviceAccountConfigured, serviceAccountEmail } from "@/lib/sheetsapi";
import { aliasAction, conflictAction, confirmAllAction, connectSheetAction, addTabsAction, sheetModeAction, stopTabAction, syncNowAction } from "./actions";
import { MappingPanel } from "./MappingPanel";

export const dynamic = "force-dynamic";
// Server actions on this page (import, sync) inherit this limit.
export const maxDuration = 60;

const fmt = (d: Date | null, tz: string) => (d ? d.toLocaleString([], { timeZone: tz }) : "Never");

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await requireCtx();
  const previewId = (await searchParams).preview;
  if (!canManage(c)) notFound();
  const conns = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.workspaceId, c.workspaceId));
  const members = await db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName, role: schema.workspaceMember.role })
    .from(schema.workspaceMember).where(and(eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true)));
  const conflicts = await db.select({ v: schema.syncConflict.sheetValue }).from(schema.syncConflict)
    .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.syncConflict.connectionId))
    .where(and(eq(schema.spreadsheetConnection.workspaceId, c.workspaceId), isNull(schema.syncConflict.resolvedAt), eq(schema.syncConflict.field, "unmapped_owner")));
  const diffs = await db.select({ c: schema.syncConflict, lead: schema.lead.name }).from(schema.syncConflict)
    .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.syncConflict.connectionId))
    .leftJoin(schema.lead, eq(schema.lead.id, schema.syncConflict.leadId))
    .where(and(eq(schema.spreadsheetConnection.workspaceId, c.workspaceId), isNull(schema.syncConflict.resolvedAt), ne(schema.syncConflict.field, "unmapped_owner")))
    .orderBy(desc(schema.syncConflict.createdAt)).limit(50);
  const saEmail = serviceAccountConfigured() ? serviceAccountEmail() : null;
  const assignable = members.filter((m) => m.role !== "viewer");
  const aliases = [...new Set(conflicts.map((x) => x.v ?? "").filter(Boolean))];

  const cards = await Promise.all(conns.map(async (cn) => ({
    cn,
    maps: await db.select().from(schema.worksheetMapping).where(and(eq(schema.worksheetMapping.connectionId, cn.id), eq(schema.worksheetMapping.enabled, true))).orderBy(schema.worksheetMapping.sheetTitle),
    jobs: await db.select().from(schema.syncJob).where(eq(schema.syncJob.connectionId, cn.id)).orderBy(desc(schema.syncJob.startedAt)).limit(8),
  })));

  return (
    <>
      <header className="top"><div><h1>Integrations</h1><p>Google Sheets feeds new leads in. In two-way mode, edits made in the CRM are written back to the sheet. Leads are never deleted when a row disappears.</p></div></header>

      {cards.map(({ cn, maps, jobs }) => (
        <section key={cn.id} className="panel glass">
          <h2>{cn.title ?? "Google Sheet"} {cn.healthy ? <span className="pill ok">Healthy</span> : <span className="pill crit">Needs attention</span>}</h2>
          <dl className="kv" style={{ gridTemplateColumns: "190px 1fr" }}>
            <dt>Mode</dt><dd>{cn.mode === "two_way" ? "Two-way: the sheet and the CRM stay in step" : "Read-only import"}</dd>
            <dt>Last successful sync</dt><dd>{fmt(cn.lastSuccessfulSyncAt, c.tz)}</dd>
            <dt>Access</dt><dd>{saEmail
              ? <>Google service account <strong>{saEmail}</strong>. Share the sheet with it as <strong>Editor</strong> for two-way sync; Viewer is enough to import.</>
              : "Link sharing, view only. Add the Google service account to the server settings to enable two-way sync."}</dd>
            {cn.lastError && <><dt>Last error</dt><dd className="err">{cn.lastError}</dd></>}
          </dl>
          {maps.length > 1 && maps.some((m) => !m.confirmedAt) && (
            <ActionForm action={confirmAllAction}>
              <input type="hidden" name="connectionId" value={cn.id} />
              <Submit pendingText="Importing">Confirm all {maps.filter((m) => !m.confirmedAt).length} tabs and import</Submit>
              <p className="sub">Uses the default columns for every tab shown. Open a tab&apos;s preview first if one needs different columns.</p>
            </ActionForm>
          )}
          {maps.map((m) => (
            <div key={m.id}>
              <MappingPanel spreadsheetId={cn.spreadsheetId} m={m} tz={c.tz} show={!m.confirmedAt || previewId === m.id} />
              <ActionForm action={stopTabAction}><input type="hidden" name="mappingId" value={m.id} /><Submit className="btn ghost">Stop tracking this tab</Submit></ActionForm>
            </div>
          ))}
          <ActionForm action={addTabsAction}><input type="hidden" name="connectionId" value={cn.id} /><Submit className="btn ghost" pendingText="Looking for tabs">Add more tabs</Submit><p className="sub">Finds tabs in this spreadsheet that are not connected yet. Connected tabs are left as they are.</p></ActionForm>
          {saEmail && (
            <ActionForm action={sheetModeAction}>
              <input type="hidden" name="connectionId" value={cn.id} />
              <input type="hidden" name="mode" value={cn.mode === "two_way" ? "read_only" : "two_way"} />
              <Submit className={cn.mode === "two_way" ? "btn ghost" : "btn"} pendingText="Checking access">{cn.mode === "two_way" ? "Switch back to read-only" : "Turn on two-way sync"}</Submit>
              <p className="sub">
                {cn.mode === "two_way"
                  ? "CRM edits to name, phone, email, campaign and source are written to the matching row. If both sides changed the same field, nothing is overwritten: it appears under “Differences” for you to settle."
                  : "Writes CRM edits and new leads to the sheet, matched by the lead id column (never by row number). Nothing is written until you turn this on. Edits already made in the CRM that the sheet does not have yet are written the first time it runs (up to 200 leads per run)."}
              </p>
            </ActionForm>
          )}
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

      {diffs.length > 0 && (
        <section className="panel glass">
          <h2>Differences between the sheet and the CRM <span className="pill warn">{diffs.length}</span></h2>
          <p className="sub">Someone changed these in the CRM, and the sheet now says something else. Nothing is overwritten on either side until you choose. “Keep CRM value” also writes it to the sheet when two-way sync is on.</p>
          {diffs.map(({ c: d, lead }) => (
            <div key={d.id} className="set-row" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div><strong>{lead ?? "Lead"}</strong> · {d.field}<small>CRM: “{d.crmValue ?? ""}” · Sheet: “{d.sheetValue ?? ""}”</small></div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["crm", "sheet"] as const).map((choice) => (
                  <ActionForm key={choice} action={conflictAction}>
                    <input type="hidden" name="conflictId" value={d.id} /><input type="hidden" name="choice" value={choice} />
                    <Submit className={choice === "crm" ? "btn ghost" : "btn"}>{choice === "crm" ? "Keep CRM value" : "Use sheet value"}</Submit>
                  </ActionForm>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

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
        <h2>Connect a sheet</h2>
        <ActionForm action={connectSheetAction}>
          <fieldset className="field" style={{ border: 0, padding: 0 }}>
            <legend>What should be tracked?</legend>
            <label style={{ display: "block" }}><input type="radio" name="scope" value="all" defaultChecked /> The whole spreadsheet: every tab, with owners matched to your team</label>
            <label style={{ display: "block" }}><input type="radio" name="scope" value="tab" /> Just one tab: open that tab first, then paste its link</label>
          </fieldset>
          <label className="field"><span>Google Sheets link (copy the address bar; for one tab it must end in gid=…)</span>
            <input type="url" name="url" placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=…" required /></label>
          <Submit pendingText="Checking">Connect</Submit>
        </ActionForm>
      </section>
    </>
  );
}
