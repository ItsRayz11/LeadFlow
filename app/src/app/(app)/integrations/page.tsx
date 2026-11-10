import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { canManage, requireCtx } from "@/lib/session";
import { ActionForm, Submit } from "@/components/ActionForm";
import { serviceAccountConfigured, serviceAccountEmail } from "@/lib/sheetsapi";
import { parseSheetUrl } from "@/lib/sheetparse";
import { fetchTabList } from "@/lib/sheetsync";
import { aliasAction, conflictAction, confirmAllAction, connectPickedAction, addTabsAction, progressWritebackAction, sheetModeAction, stopTabAction, syncNowAction } from "./actions";
import { MappingPanel } from "./MappingPanel";

export const dynamic = "force-dynamic";
// Server actions on this page (import, sync) inherit this limit.
export const maxDuration = 60;

const fmt = (d: Date | null, tz: string) => (d ? d.toLocaleString([], { timeZone: tz }) : "Never");

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await requireCtx();
  const sp = await searchParams;
  const previewId = sp.preview;
  const sheetParam = typeof sp.sheet === "string" ? sp.sheet.trim() : "";
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

  // Tab picker: list the tabs of the pasted spreadsheet, marking the ones already tracked.
  let picker: { spreadsheetId: string; tabs: { gid: string; title: string }[]; have: Set<string>; linked: string | null } | { error: string } | null = null;
  if (sheetParam) {
    const parsed = parseSheetUrl(sheetParam);
    if (!parsed) picker = { error: "That does not look like a Google Sheets link. Copy the address from your browser (https://docs.google.com/spreadsheets/d/…)." };
    else {
      try {
        const tabs = await fetchTabList(parsed.spreadsheetId);
        const mine = cards.find((x) => x.cn.spreadsheetId === parsed.spreadsheetId);
        picker = { spreadsheetId: parsed.spreadsheetId, tabs, have: new Set((mine?.maps ?? []).map((m) => m.sheetGid)), linked: parsed.gid };
      } catch (e) { picker = { error: e instanceof Error ? e.message : "The tabs could not be listed." }; }
    }
  }

  const connIds = conns.map((x) => x.id);
  const [{ imported }] = connIds.length
    ? await db.select({ imported: sql<number>`count(*)::int` }).from(schema.lead).where(inArray(schema.lead.connectionId, connIds))
    : [{ imported: 0 }];
  const allMaps = cards.flatMap((x) => x.maps);
  const confirmedN = allMaps.filter((m) => m.confirmedAt).length;
  const twoWay = conns.some((x) => x.mode === "two_way");
  const writesProgress = allMaps.some((m) => (m.valueMaps as { writeProgress?: boolean } | null)?.writeProgress === true);
  const steps = [
    { done: !!saEmail, title: "Let the app reach your Google Sheet", body: saEmail ? <>Done. The app signs in as <strong>{saEmail}</strong>. Share each sheet with that address as <strong>Editor</strong>.</> : "Ask the person who runs the server to add the Google service account settings. Until then only link-shared sheets can be read." },
    { done: allMaps.length > 0, title: "Choose the tab you work in", body: allMaps.length ? `Tracking ${allMaps.length} tab${allMaps.length === 1 ? "" : "s"}.` : "Paste your sheet link under “Choose tabs to track” below, then tick the tab (or tabs) assigned to you." },
    { done: confirmedN > 0, title: "Check the columns, then import", body: confirmedN ? `${imported} lead${imported === 1 ? "" : "s"} imported. Their owner, status, follow-up stage, card steps and notes come with them.` : "Open the preview on your tab, check the columns look right, and press confirm. Existing progress in the sheet is imported, so you do not start from scratch." },
    { done: confirmedN > 0 && aliases.length === 0, title: "Match names in the sheet to your team", body: aliases.length ? `${aliases.length} name${aliases.length === 1 ? "" : "s"} in the sheet match nobody yet. Link them below and those leads are assigned straight away.` : confirmedN ? "Every owner name in the sheet is matched." : "Appears after the first import." },
    { done: twoWay, title: "Turn on two-way sync", body: twoWay ? "On. Edits to name, phone, email, campaign and source go to the sheet." : "Do this after the import looks right. Edits you make in the CRM are then written to the sheet." },
    { done: writesProgress, title: "Also write status and follow-up stage back", body: writesProgress ? "On. Your sheet's Status and Lead Follow Up cells follow what you do in the CRM." : "Optional, after two-way is on. Your sheet's dropdowns will follow what you do in the CRM." },
  ];
  const nextStep = steps.findIndex((x) => !x.done);

  return (
    <>
      <header className="top"><div><h1>Integrations</h1><p>Google Sheets feeds new leads in. In two-way mode, edits made in the CRM are written back to the sheet. Leads are never deleted when a row disappears.</p></div></header>

      <section className="panel glass" aria-labelledby="start-here">
        <h2 id="start-here">Start here {nextStep === -1 ? <span className="pill ok">All set</span> : <span className="pill warn">Step {nextStep + 1} of {steps.length}</span>}</h2>
        <ol className="plain" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {steps.map((st, i) => (
            <li key={st.title} style={{ display: "flex", gap: 10, padding: "8px 0", alignItems: "flex-start", opacity: st.done || i === nextStep ? 1 : 0.6 }}>
              <span className={`pill ${st.done ? "ok" : i === nextStep ? "warn" : "mute"}`} aria-label={st.done ? "Done" : i === nextStep ? "Next" : "Later"}>{st.done ? "✓" : i + 1}</span>
              <div><strong>{st.title}</strong>{i === nextStep && <span className="pill warn" style={{ marginLeft: 8 }}>Do this next</span>}<div className="sub">{st.body}</div></div>
            </li>
          ))}
        </ol>
        <p className="sub">Optional: for instant updates when someone edits the sheet, paste the script from <code>docs/apps-script/lead-flow-sync.gs</code> into the sheet. Without it the sheet is still read every few minutes.</p>
      </section>

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
          {saEmail && cn.mode === "two_way" && (() => {
            const on = maps.some((m) => (m.valueMaps as { writeProgress?: boolean } | null)?.writeProgress === true);
            return (
              <ActionForm action={progressWritebackAction}>
                <input type="hidden" name="connectionId" value={cn.id} />
                <input type="hidden" name="on" value={on ? "0" : "1"} />
                <Submit className={on ? "btn ghost" : "btn"} pendingText="Saving">{on ? "Stop writing status and follow-up stage" : "Also write status and follow-up stage to the sheet"}</Submit>
                <p className="sub">{on
                  ? "The sheet's Status and Lead Follow Up cells follow the CRM, using the same wording and emoji your sheet already uses. If you both change a lead, it shows under “Differences”."
                  : "Turn this on after you have checked the import. The CRM then updates the Status and Lead Follow Up cells, using your sheet's own wording."}</p>
              </ActionForm>
            );
          })()}
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
              <div><strong>{lead ?? "Lead"}</strong> · {d.field === "progress" ? "status and follow-up stage" : d.field}<small>CRM: “{d.crmValue ?? ""}” · Sheet: “{d.sheetValue ?? ""}”</small></div>
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
        <h2>Choose tabs to track</h2>
        <form method="get" className="grid2" style={{ alignItems: "end" }}>
          <label className="field"><span>1. Paste your Google Sheets link (any tab will do)</span>
            <input type="url" name="sheet" defaultValue={sheetParam} placeholder="https://docs.google.com/spreadsheets/d/…" required /></label>
          <div><button className="btn">Find tabs</button></div>
        </form>
        {picker && "error" in picker && <p className="err" role="alert">{picker.error}</p>}
        {picker && "tabs" in picker && (
          <ActionForm action={connectPickedAction}>
            <input type="hidden" name="spreadsheetId" value={picker.spreadsheetId} />
            <fieldset className="field" style={{ border: 0, padding: 0 }}>
              <legend>2. Tick the tab(s) you want to track ({picker.tabs.length} found)</legend>
              {picker.tabs.map((t) => (
                <label key={t.gid} style={{ display: "block", opacity: picker.have.has(t.gid) ? 0.6 : 1 }}>
                  <input type="checkbox" name="gid" value={t.gid} defaultChecked={picker.have.has(t.gid) || t.gid === picker.linked} disabled={picker.have.has(t.gid)} /> {t.title}
                  {picker.have.has(t.gid) && <span className="sub"> · already tracked</span>}
                  {t.gid === picker.linked && !picker.have.has(t.gid) && <span className="sub"> · the tab from your link</span>}
                </label>
              ))}
            </fieldset>
            <Submit pendingText="Checking the tabs">Track the ticked tabs</Submit>
            <p className="sub">Each tab is checked for the expected columns first. Tabs that do not look like lead lists are reported and left out, never half-connected.</p>
          </ActionForm>
        )}
      </section>
    </>
  );
}
