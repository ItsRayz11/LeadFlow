import "server-only";
import { and, eq } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { db, schema } from "@/db";
import { DEFAULT_COLUMN_MAP, parseWorksheet } from "@/lib/sheetparse";
import { BudgetError, fetchWorksheetCsv } from "@/lib/sheetsync";
import { planTabSave, problemText, type TabProblem } from "@/lib/tabs";

/** Result of saving a tab selection: per-tab warnings keyed by gid, so one bad tab never hides the good ones. */
export type TabSaveResult = { ok?: boolean; error?: string; message?: string; link?: string; warnings?: Record<string, string> } | undefined;

/** The slice of the signed-in context these functions need. */
export type TabCtx = { workspaceId: string; userId: string; tz: string };

export const tabNames = (ps: TabProblem[]) => ps.map(problemText).join("; ");

export type Tab = { gid: string; title: string };


/**
 * Proves each tab is readable and has the expected columns. Every tab is judged on its own: a bad tab is reported with its exact name and
 * missing columns and never blocks a good one. `left` counts tabs not reached because the time budget ran out.
 */
export async function checkTabs(c: TabCtx, spreadsheetId: string, tabs: Tab[], deadline: number, strict = false) {
  const good: Tab[] = [], problems: TabProblem[] = [];
  let left = 0;
  for (const [i, t] of tabs.entries()) {
    try {
      const table = await fetchWorksheetCsv(spreadsheetId, t.gid, deadline);
      if (!table.length) { problems.push({ ...t, reason: "is empty" }); continue; }
      const check = parseWorksheet(table, DEFAULT_COLUMN_MAP, c.tz, fromZonedTime);
      if (check.missingColumns.length) problems.push({ ...t, reason: `is missing ${check.missingColumns.join(", ")}` });
      else good.push(t);
    } catch (e) {
      if (e instanceof BudgetError) { left = tabs.length - i; break; }
      if (strict) throw e;
      problems.push({ ...t, reason: "could not be read" });
    }
  }
  return { good, problems, left };
}

/** Creates the connection if needed and switches the given (already validated) tabs on. They wait for confirmation before importing. */
export async function enableTabs(c: TabCtx, spreadsheetId: string, good: Tab[], via: string) {
  const [conn] = await db.insert(schema.spreadsheetConnection).values({
    workspaceId: c.workspaceId, spreadsheetId, title: "Google Sheet", mode: "read_only",
  }).onConflictDoUpdate({ target: [schema.spreadsheetConnection.workspaceId, schema.spreadsheetConnection.spreadsheetId], set: { healthy: true, lastError: null } })
    .returning({ id: schema.spreadsheetConnection.id });
  for (const t of good) {
    // A tab that was switched off is switched back on and must be confirmed again. Its saved column mapping is kept.
    await db.insert(schema.worksheetMapping).values({
      connectionId: conn.id, sheetGid: t.gid, sheetTitle: t.title, enabled: true, headerRow: 1,
      columnMap: DEFAULT_COLUMN_MAP, identityStrategy: "source_id_column",
    }).onConflictDoUpdate({ target: [schema.worksheetMapping.connectionId, schema.worksheetMapping.sheetGid], set: { enabled: true, sheetTitle: t.title, confirmedAt: null } });
  }
  await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "sheet.connect", entity: "spreadsheet_connection", entityId: conn.id, data: { via, gids: good.map((t) => t.gid) } });
  return conn;
}


/**
 * Saves a tick-list of tabs for one connection.
 *  - Only the ticked tabs are validated. A ticked tab with missing columns is reported by name and left off; it never blocks the others.
 *  - Unticked tabs are switched off (their leads stay). Tabs that stay ticked are not touched, so they keep their mapping and keep syncing.
 *  - Tabs that appeared in the spreadsheet since and were not ticked stay off. Saving never turns on anything that was not ticked.
 */
export async function applyTabSelection(c: TabCtx, conn: { id: string; spreadsheetId: string }, live: Tab[], ticked: string[]): Promise<TabSaveResult> {
  const maps = await db.select().from(schema.worksheetMapping).where(and(eq(schema.worksheetMapping.connectionId, conn.id), eq(schema.worksheetMapping.enabled, true)));
  const plan = planTabSave(ticked, live.map((t) => t.gid), maps.map((m) => m.sheetGid));
  const titleOf = (g: string) => live.find((t) => t.gid === g)?.title ?? `Worksheet ${g}`;

  // Validate only what is being switched on.
  const { good, problems } = await checkTabs(c, conn.spreadsheetId, plan.add.map((g) => ({ gid: g, title: titleOf(g) })), Date.now() + 40_000);
  const unchecked: TabProblem[] = plan.add.filter((g) => !good.some((t) => t.gid === g) && !problems.some((x) => x.gid === g))
    .map((g) => ({ gid: g, title: titleOf(g), reason: "was not checked in time. Save again" }));
  const bad = [...problems, ...unchecked];
  const warnings: Record<string, string> = Object.fromEntries(bad.map((x) => [x.gid, x.reason.replace(/\. Save again$/, "")]));

  const stopMaps = maps.filter((m) => plan.stop.includes(m.sheetGid));
  for (const m of stopMaps) {
    await db.update(schema.worksheetMapping).set({ enabled: false, confirmedAt: null }).where(eq(schema.worksheetMapping.id, m.id));
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "sheet.stop_tab", entity: "worksheet_mapping", entityId: m.id, data: {} });
  }
  if (good.length) await enableTabs(c, conn.spreadsheetId, good, "save_tabs");
  // Keep saved names current (a renamed tab, or an id-style placeholder stored earlier).
  for (const m of maps) {
    const t = live.find((x) => x.gid === m.sheetGid);
    if (t && t.title !== m.sheetTitle) await db.update(schema.worksheetMapping).set({ sheetTitle: t.title }).where(eq(schema.worksheetMapping.id, m.id));
  }

  if (!good.length && !stopMaps.length && bad.length) return { error: `Nothing changed. ${tabNames(bad)}.`, warnings };
  const parts: string[] = [];
  if (good.length) parts.push(`Connected ${good.length} tab${good.length === 1 ? "" : "s"}; confirm ${good.length === 1 ? "it" : "them"} below to start importing.`);
  if (stopMaps.length) parts.push(`Stopped ${stopMaps.length} tab${stopMaps.length === 1 ? "" : "s"}; leads already imported stay in the CRM.`);
  if (!parts.length) parts.push(plan.keep.length ? "Selection unchanged; the selected tabs keep syncing." : "No changes.");
  if (bad.length) parts.push(`Not connected: ${tabNames(bad)}.`);
  return { ok: true, message: parts.join(" "), warnings };
}
