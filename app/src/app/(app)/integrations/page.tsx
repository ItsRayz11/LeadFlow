import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { canManage, requireCtx } from "@/lib/session";
import { ActionForm, Submit } from "@/components/ActionForm";
import { serviceAccountConfigured, serviceAccountEmail } from "@/lib/sheetsapi";
import { parseSheetUrl } from "@/lib/sheetparse";
import { fetchTabList } from "@/lib/sheetsync";
import { aliasAction, conflictAction, confirmAllAction, connectPickedAction, addTabsAction, saveTabsAction, progressWritebackAction, sheetModeAction, stopTabAction, syncNowAction } from "./actions";
import { MappingPanel } from "./MappingPanel";
import { TabSyncPicker } from "./TabSyncPicker";
import { tabState, visibleTabTitle } from "@/lib/tabs";

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
    jobs: await db.select().from(schema.syncJob).where(eq(schema.syncJob.connectionId, cn.id)).orderBy(desc(schema.syncJob.startedAt)).limit(20),
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

  // Live list of every tab in each connected spreadsheet, merged with what is saved. Saved names are refreshed from Google so an
  // id-style placeholder ("Worksheet 123") never lingers.
  const tabLists = await Promise.all(cards.map(async ({ cn, maps }) => {
    const all = await db.select().from(schema.worksheetMapping).where(eq(schema.worksheetMapping.connectionId, cn.id));
    try {
      const tabs = await fetchTabList(cn.spreadsheetId);
      for (const m of all) {
        const t = tabs.find((x) => x.gid === m.sheetGid);
        if (t && t.title !== m.sheetTitle) { await db.update(schema.worksheetMapping).set({ sheetTitle: t.title }).where(eq(schema.worksheetMapping.id, m.id)); m.sheetTitle = t.title; }
      }
      return { cn, maps, all, tabs, err: null as string | null };
    } catch (e) { return { cn, maps, all, tabs: [] as { gid: string; title: string }[], err: e instanceof Error ? e.message : "Tabs could not be listed." }; }
  }));

  const connIds = conns.map((x) => x.id);
  const [{ imported }] = connIds.length
    ? await db.select({ imported: sql<number>`count(*)::int` }).from(schema.lead).where(inArray(schema.lead.connectionId, connIds))
    : [{ imported: 0 }];
  const perTab = connIds.length
    ? await db.select({ conn: schema.lead.connectionId, gid: schema.lead.sheetGid, n: sql<number>`count(*)::int` }).from(schema.lead).where(inArray(schema.lead.connectionId, connIds)).groupBy(schema.lead.connectionId, schema.lead.sheetGid)
    : [];
  const leadCounts = new Map(perTab.map((x) => [`${x.conn}:${x.gid}`, x.n]));
  const allMaps = cards.flatMap((x) => x.maps);
  const confirmedN = allMaps.filter((m) => m.confirmedAt).length;
  const twoWay = conns.some((x) => x.mode === "two_way");
  const writesProgress = allMaps.some((m) => (m.valueMaps as { writeProgress?: boolean } | null)?.writeProgress === true);
  const steps = [
    { done: !!saEmail, title: "Connect Google Sheet", body: saEmail ? "Service account ready. Share each sheet with it as Editor." : "Server needs Google service account settings." },
    { done: allMaps.length > 0, title: "Choose Tabs", body: allMaps.length ? `Tracking ${allMaps.length} tab${allMaps.length === 1 ? "" : "s"}.` : "Paste your sheet link below and tick your tabs." },
    { done: confirmedN > 0, title: "Check Columns", body: confirmedN ? `${imported} lead${imported === 1 ? "" : "s"} imported.` : "Preview a tab, check the columns, then confirm." },
    { done: confirmedN > 0 && aliases.length === 0, title: "Match Team Members", body: aliases.length ? `${aliases.length} sheet name${aliases.length === 1 ? "" : "s"} still unmatched.` : confirmedN ? "All owner names matched." : "Appears after the first import." },
    { done: twoWay, title: "Enable Two-Way Sync", body: twoWay ? "On. CRM edits are written to the sheet." : "Turn on once the import looks right." },
    { done: writesProgress, title: "Sync Status and Follow-up Updates", body: writesProgress ? "On. Status and follow-up cells follow the CRM." : "Optional, after two-way is on." },
  ];
  const nextStep = steps.findIndex((x) => !x.done);
  const doneN = steps.filter((x) => x.done).length;
  const histPill = (st: string) => (st === "success" ? "ok" : st === "running" ? "mute" : st === "partial" ? "warn" : "crit");
  const shortDate = (d: Date | null) => (d ? d.toLocaleString([], { timeZone: c.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never");
  const histRow = (j: (typeof cards)[number]["jobs"][number]) => (
    <li key={j.id}>
      <span className={`pill ${histPill(j.status)}`}>{j.status}</span>
      <span className="when2" title={`${fmt(j.startedAt, c.tz)} · ${j.trigger}`}>{shortDate(j.startedAt)} · {j.trigger}</span>
      <span className="nums"><b>{j.rowsCreated}</b> new · <b>{j.rowsUpdated}</b> updated · <b>{j.rowsSkipped}</b> skipped</span>
      {j.error && <span className="errl">{j.error}</span>}
    </li>
  );

  return (
    <>
      <header className="top slim"><div><h1>Integrations</h1><p>Manage Google Sheets connections, tracked tabs and automatic CRM synchronization.</p></div></header>

      <section className="icard glass" aria-labelledby="start-here">
        <h2 id="start-here">Setup checklist {nextStep === -1 ? <span className="pill ok">All set</span> : <span className="pill warn">{doneN} of {steps.length} done</span>}</h2>
        <ol className="chk-list cols2">
          {steps.map((st, i) => (
            <li key={st.title} className={st.done || i === nextStep ? "" : "later"}>
              <span className={`dotn ${st.done ? "ok" : i === nextStep ? "next" : ""}`} aria-label={st.done ? "Done" : i === nextStep ? "Next" : "Later"}>{st.done ? "✓" : i + 1}</span>
              <div><b>{st.title}</b>{i === nextStep && <span className="pill warn minipill">Next</span>}<div className="sub">{st.body}</div></div>
            </li>
          ))}
        </ol>
      </section>

      {tabLists.map(({ cn, maps, all, tabs, err }) => {
        const pickerTabs = tabs.map((t) => {
          const m = all.find((x) => x.sheetGid === t.gid);
          return { gid: t.gid, title: visibleTabTitle(t.title), state: tabState(m, (leadCounts.get(`${cn.id}:${t.gid}`) ?? 0) > 0) };
        });
        const jobs = cards.find((x) => x.cn.id === cn.id)?.jobs ?? [];
        const pending = maps.filter((m) => !m.confirmedAt);
        const progressOn = maps.some((m) => (m.valueMaps as { writeProgress?: boolean } | null)?.writeProgress === true);
        return (
          <div key={cn.id} className="igrid">
            <section className="icard glass">
              <h2>{cn.title ?? "Google Sheet"} {cn.healthy ? <span className="pill ok">Healthy</span> : <span className="pill crit">Needs attention</span>}</h2>
              <dl className="kvc">
                <div><dt>Connection</dt><dd>Google Sheets · {cn.healthy ? "Connected" : "Problem"}</dd></div>
                <div><dt>Sync mode</dt><dd>{cn.mode === "two_way" ? "Two-way" : "Read-only import"}</dd></div>
                <div><dt>Last successful sync</dt><dd>{fmt(cn.lastSuccessfulSyncAt, c.tz)}</dd></div>
                <div><dt>Tracked tabs</dt><dd>{maps.length}</dd></div>
                <div className="full"><dt>Access method</dt><dd>{saEmail ? <>Service account <strong>{saEmail}</strong> (Editor for two-way, Viewer to import)</> : "Link sharing, view only"}</dd></div>
                {cn.lastError && <div className="full"><dt>Last error</dt><dd className="err">{cn.lastError}</dd></div>}
              </dl>
              <div className="inline-form">
                {maps.some((m) => m.confirmedAt) && (
                  <ActionForm action={syncNowAction} className="inline-form"><input type="hidden" name="connectionId" value={cn.id} /><Submit pendingText="Syncing">Sync now</Submit></ActionForm>
                )}
                {saEmail && (
                  <ActionForm action={sheetModeAction} className="inline-form">
                    <input type="hidden" name="connectionId" value={cn.id} />
                    <input type="hidden" name="mode" value={cn.mode === "two_way" ? "read_only" : "two_way"} />
                    <Submit className={cn.mode === "two_way" ? "btn ghost" : "btn"} pendingText="Checking access">{cn.mode === "two_way" ? "Switch to read-only" : "Turn on two-way sync"}</Submit>
                  </ActionForm>
                )}
                {saEmail && cn.mode === "two_way" && (
                  <ActionForm action={progressWritebackAction} className="inline-form">
                    <input type="hidden" name="connectionId" value={cn.id} />
                    <input type="hidden" name="on" value={progressOn ? "0" : "1"} />
                    <Submit className={progressOn ? "btn ghost" : "btn"} pendingText="Saving">{progressOn ? "Stop writing status and follow-up stage" : "Also write status and follow-up stage"}</Submit>
                  </ActionForm>
                )}
              </div>
              <p className="sub">{cn.mode === "two_way" ? "CRM edits to name, phone, email, campaign and source go to the sheet; conflicts appear under Differences." : "Turn on two-way sync to write CRM edits to the sheet."} Auto-syncs every 10 minutes while the app is open.</p>
            </section>

            <section className="icard glass">
              <h2>Tabs being synced <span className="pill ok">{maps.length} selected</span></h2>
              {err ? <p className="err" role="alert">{err}</p> : (
                <TabSyncPicker
                  action={saveTabsAction} hidden={{ connectionId: cn.id }} tabs={pickerTabs}
                  initial={maps.map((m) => m.sheetGid)}
                  note="New tabs are checked, then wait for your confirmation. Unticked tabs stop syncing; their leads stay."
                />
              )}
            </section>

            <section className="icard glass">
              <h2>Tracked tabs <span className="pill mute">{maps.length}</span></h2>
              {maps.length === 0 && <p className="sub">No tabs tracked yet.</p>}
              {pending.length > 1 && (
                <ActionForm action={confirmAllAction} className="inline-form">
                  <input type="hidden" name="connectionId" value={cn.id} />
                  <Submit pendingText="Importing">Confirm all {pending.length} tabs and import</Submit>
                  <span className="sub">Uses default columns for each.</span>
                </ActionForm>
              )}
              <div>
                {maps.map((m) => {
                  const n = leadCounts.get(`${cn.id}:${m.sheetGid}`) ?? 0;
                  const st = tabState(m, n > 0);
                  return (
                    <div key={m.id} className="trow">
                      <span className="tn">{visibleTabTitle(m.sheetTitle)} <span className="sub num">{n} lead{n === 1 ? "" : "s"}</span></span>
                      <span className={`pill ${m.confirmedAt ? "ok" : "warn"}`}>{m.confirmedAt ? "Mapped" : "Not confirmed"}</span>
                      <span className={`pill ${st === "syncing" ? "ok" : st === "waiting" ? "warn" : "mute"}`}>{st === "syncing" ? "Syncing" : st === "waiting" ? "Awaiting confirmation" : "Paused"}</span>
                      <span className="tact">
                        <a className="chip sm" href={`/integrations?preview=${m.id}`}>Preview mapping</a>
                        <ActionForm action={stopTabAction}><input type="hidden" name="mappingId" value={m.id} /><Submit className="chip sm" pendingText="Stopping">Stop tracking</Submit></ActionForm>
                      </span>
                    </div>
                  );
                })}
              </div>
              {maps.map((m) => <MappingPanel key={m.id} spreadsheetId={cn.spreadsheetId} m={m} tz={c.tz} show={!m.confirmedAt || previewId === m.id} />)}
              <ActionForm action={addTabsAction} className="inline-form"><input type="hidden" name="connectionId" value={cn.id} /><Submit className="btn ghost" pendingText="Looking for tabs">Find untracked tabs</Submit><span className="sub">Lists tabs in this spreadsheet that are not connected yet.</span></ActionForm>
            </section>

            <section className="icard glass">
              <h2>Sync history</h2>
              {jobs.length === 0 ? <p className="sub">No syncs yet.</p> : (
                <>
                  <ul className="hist">{jobs.slice(0, 5).map(histRow)}</ul>
                  {jobs.length > 5 && (
                    <details>
                      <summary className="sub" style={{ cursor: "pointer" }}>View all ({jobs.length})</summary>
                      <ul className="hist">{jobs.slice(5).map(histRow)}</ul>
                    </details>
                  )}
                </>
              )}
            </section>
          </div>
        );
      })}

      {diffs.length > 0 && (
        <section className="icard glass">
          <h2>Differences between the sheet and the CRM <span className="pill warn">{diffs.length}</span></h2>
          <p className="sub">Nothing is overwritten until you choose. “Keep CRM value” also writes it to the sheet when two-way sync is on.</p>
          {diffs.map(({ c: d, lead }) => (
            <div key={d.id} className="set-row" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 8, minHeight: 0 }}>
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
        <section className="icard glass">
          <h2>Names in the sheet that match nobody <span className="pill warn">{aliases.length}</span></h2>
          <p className="sub">Link each name to a team member; those leads are assigned straight away.</p>
          {aliases.map((alias) => (
            <ActionForm key={alias} action={aliasAction} className="inline-form">
              <input type="hidden" name="alias" value={alias} />
              <label className="field" style={{ flex: "1 1 260px" }}><span>“{alias}” is</span>
                <select name="memberId" required defaultValue="" style={{ minHeight: 34, padding: "4px 10px" }}>
                  <option value="" disabled>Choose a person</option>
                  {assignable.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>
              <Submit>Link</Submit>
            </ActionForm>
          ))}
        </section>
      )}

      <section className="icard glass">
        <h2>Add more tabs</h2>
        <form method="get" className="inline-form">
          <label style={{ flex: "1 1 320px", display: "flex" }}><span className="sr">Google Sheets link</span>
            <input type="url" name="sheet" defaultValue={sheetParam} placeholder="Google Sheets URL: https://docs.google.com/spreadsheets/d/…" required style={{ width: "100%" }} /></label>
          <button className="btn">Find tabs</button>
        </form>
        {picker && "error" in picker && <p className="err" role="alert">{picker.error}</p>}
        {picker && "tabs" in picker && (
          <TabSyncPicker
            action={connectPickedAction} hidden={{ spreadsheetId: picker.spreadsheetId }} saveLabel="Track the selected tabs"
            tabs={picker.tabs.map((t) => ({ gid: t.gid, title: visibleTabTitle(t.title), state: picker.have.has(t.gid) ? "syncing" as const : "off" as const, locked: picker.have.has(t.gid), hint: picker.have.has(t.gid) ? "Already tracked. Change it under “Tabs being synced”." : t.gid === picker.linked ? "The tab from your link" : undefined }))}
            initial={[...picker.have, ...(picker.linked && !picker.have.has(picker.linked) ? [picker.linked] : [])]}
            note="Each tab is checked for the expected columns. Tabs that don’t look like lead lists are reported and left out."
          />
        )}
      </section>
    </>
  );
}
