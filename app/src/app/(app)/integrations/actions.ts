"use server";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireCtx } from "@/lib/session";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_COLUMN_MAP, parseSheetUrl, parseWorksheet } from "@/lib/sheetparse";
import { BudgetError, PermanentSyncError, fetchTabList, fetchWorksheetCsv, syncConnection } from "@/lib/sheetsync";
import { linkAlias, resolveFieldConflict, saveMapping } from "@/lib/sheetops";
import type { R } from "../actions";


async function manager() {
  const c = await requireCtx();
  if (c.role !== "admin" && c.role !== "manager") throw new PermanentSyncError("Only managers and admins can do this.");
  return c;
}
const fail = (e: unknown): R => {
  // An expired session redirects to /login; do not swallow that into a generic error.
  if ((e as { digest?: string } | null)?.digest?.startsWith("NEXT_REDIRECT")) throw e;
  if (e instanceof PermanentSyncError) return { error: e.message };
  console.error(e);
  return { error: "Something went wrong. Nothing was changed. Try again." };
};
const ok = (message: string): R => { revalidatePath("/integrations"); revalidatePath("/", "layout"); return { ok: true, message }; };

const MAX_TABS = 12;

/** Connects either one tab ("tab") or every tab of the spreadsheet ("all"). Tabs without the expected columns are reported, never half-connected. */
export async function connectSheetAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ url: z.string().max(500), scope: z.enum(["tab", "all"]).default("tab") }).safeParse(Object.fromEntries(fd));
  const parsed = p.success ? parseSheetUrl(p.data.url) : null;
  if (!p.success || !parsed) return { error: "Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/…)." };
  const scope = p.data.scope;
  if (scope === "tab" && !parsed.gid) return { error: "To track one tab, open that tab and paste the full link; it must contain gid=…" };
  const deadline = Date.now() + 50_000;
  try {
    const c = await manager();
    // Which tabs: the one in the link, or everything the spreadsheet lists.
    let tabs: { gid: string; title: string }[];
    if (scope === "all") {
      tabs = await fetchTabList(parsed.spreadsheetId);
      if (tabs.length > MAX_TABS) return { error: `This spreadsheet has ${tabs.length} tabs; at most ${MAX_TABS} can be connected at once. Connect the ones you need one at a time.` };
    } else {
      const known = await fetchTabList(parsed.spreadsheetId).catch(() => []);
      tabs = [{ gid: parsed.gid!, title: known.find((t) => t.gid === parsed.gid)?.title ?? `Worksheet ${parsed.gid}` }];
    }
    // Prove each tab is readable and has the expected columns before saving anything.
    const good: typeof tabs = [], problems: string[] = [];
    for (const t of tabs) {
      try {
        const table = await fetchWorksheetCsv(parsed.spreadsheetId, t.gid, deadline);
        if (!table.length) { problems.push(`“${t.title}” is empty`); continue; }
        const check = parseWorksheet(table, DEFAULT_COLUMN_MAP, c.tz, fromZonedTime);
        if (check.missingColumns.length) problems.push(`“${t.title}” is missing ${check.missingColumns.join(", ")}`);
        else good.push(t);
      } catch (e) {
        if (scope === "tab" || e instanceof BudgetError) throw e;
        problems.push(`“${t.title}” could not be read`);
      }
    }
    if (!good.length) return { error: `Nothing was connected. ${problems.join("; ") || "No tabs found."}.` };
    const [conn] = await db.insert(schema.spreadsheetConnection).values({
      workspaceId: c.workspaceId, spreadsheetId: parsed.spreadsheetId, title: "Google Sheet", mode: "read_only",
    }).onConflictDoUpdate({ target: [schema.spreadsheetConnection.workspaceId, schema.spreadsheetConnection.spreadsheetId], set: { healthy: true, lastError: null } })
      .returning({ id: schema.spreadsheetConnection.id });
    for (const t of good) {
      // A tab connected earlier keeps its mapping; one that was switched off is switched back on and must be confirmed again.
      await db.insert(schema.worksheetMapping).values({
        connectionId: conn.id, sheetGid: t.gid, sheetTitle: t.title, enabled: true, headerRow: 1,
        columnMap: DEFAULT_COLUMN_MAP, identityStrategy: "source_id_column",
      }).onConflictDoUpdate({ target: [schema.worksheetMapping.connectionId, schema.worksheetMapping.sheetGid], set: { enabled: true, sheetTitle: t.title } });
    }
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "sheet.connect", entity: "spreadsheet_connection", entityId: conn.id, data: { scope, gids: good.map((t) => t.gid) } });
    const skipped = problems.length ? ` Not connected: ${problems.join("; ")}.` : "";
    return ok(`Connected ${good.length} tab${good.length === 1 ? "" : "s"}. Review the column mapping below, then confirm to import.${skipped}`);
  } catch (e) {
    if (e instanceof BudgetError) return { error: "Reading the tabs took too long. Nothing was connected; try again or connect fewer tabs." };
    return fail(e);
  }
}

/** Stops tracking one tab. Leads already imported stay in the CRM; other tabs are untouched. */
export async function stopTabAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ mappingId: z.string().uuid() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await manager();
    const [row] = await db.select({ id: schema.worksheetMapping.id }).from(schema.worksheetMapping)
      .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.worksheetMapping.connectionId))
      .where(and(eq(schema.worksheetMapping.id, p.data.mappingId), eq(schema.spreadsheetConnection.workspaceId, c.workspaceId)));
    if (!row) return { error: "Worksheet not found." };
    await db.update(schema.worksheetMapping).set({ enabled: false, confirmedAt: null }).where(eq(schema.worksheetMapping.id, row.id));
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "sheet.stop_tab", entity: "worksheet_mapping", entityId: row.id, data: {} });
    return ok("Stopped. Leads already imported from this tab stay in the CRM.");
  } catch (e) { return fail(e); }
}

export async function confirmMappingAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ mappingId: z.string().uuid() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await manager();
    const [row] = await db.select({ m: schema.worksheetMapping }).from(schema.worksheetMapping)
      .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.worksheetMapping.connectionId))
      .where(and(eq(schema.worksheetMapping.id, p.data.mappingId), eq(schema.spreadsheetConnection.workspaceId, c.workspaceId)));
    if (!row) return { error: "Worksheet not found." };
    await db.update(schema.worksheetMapping).set({ confirmedAt: new Date(), enabled: true }).where(eq(schema.worksheetMapping.id, row.m.id));
    const s = await syncConnection(row.m.connectionId, "initial", c.userId, Date.now() + 50_000);
    if (!s.ran) return { error: "A sync is already running for this sheet. Wait a minute and check the history below." };
    if (s.partial) return ok(`Imported ${s.created} leads so far. It did not finish in the time allowed and will continue automatically on the next run.`);
    return ok(`Imported ${s.created} new leads (${s.assigned} assigned from the owner column, ${s.skipped} rows skipped).`);
  } catch (e) { return fail(e); }
}

/** Confirms every tab of a connection that still waits for confirmation, then imports once. */
export async function confirmAllAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ connectionId: z.string().uuid() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await manager();
    const [conn] = await db.select({ id: schema.spreadsheetConnection.id }).from(schema.spreadsheetConnection)
      .where(and(eq(schema.spreadsheetConnection.id, p.data.connectionId), eq(schema.spreadsheetConnection.workspaceId, c.workspaceId)));
    if (!conn) return { error: "Connection not found." };
    await db.update(schema.worksheetMapping).set({ confirmedAt: new Date() })
      .where(and(eq(schema.worksheetMapping.connectionId, conn.id), eq(schema.worksheetMapping.enabled, true), isNull(schema.worksheetMapping.confirmedAt)));
    const s = await syncConnection(conn.id, "initial", c.userId, Date.now() + 50_000);
    if (!s.ran) return { error: "A sync is already running for this sheet. Wait a minute and check the history below." };
    if (s.partial) return ok(`Imported ${s.created} leads so far. It did not finish in the time allowed and will continue automatically on the next run.`);
    return ok(`Imported ${s.created} new leads (${s.assigned} assigned from the owner column, ${s.skipped} rows skipped).`);
  } catch (e) { return fail(e); }
}

export async function syncNowAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ connectionId: z.string().uuid() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await manager();
    const [conn] = await db.select({ id: schema.spreadsheetConnection.id }).from(schema.spreadsheetConnection)
      .where(and(eq(schema.spreadsheetConnection.id, p.data.connectionId), eq(schema.spreadsheetConnection.workspaceId, c.workspaceId)));
    if (!conn) return { error: "Connection not found." };
    const s = await syncConnection(conn.id, "manual", c.userId, Date.now() + 50_000);
    if (!s.ran) return { error: "A sync is already running for this sheet, or no worksheet is confirmed yet." };
    if (s.partial) return ok(`Synced ${s.created} new so far. It did not finish in the time allowed and will continue on the next run.`);
    return ok(`Sync finished: ${s.created} new, ${s.updated} updated, ${s.skipped} skipped.`);
  } catch (e) { return fail(e); }
}

export async function aliasAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ alias: z.string().min(1).max(80), memberId: z.string().uuid() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Pick a team member." };
  try {
    const c = await manager();
    await linkAlias(c.workspaceId, c.userId, p.data.alias, p.data.memberId);
    return ok("Saved. Future syncs assign this name to that person. Leads already imported can be assigned from the Leads page.");
  } catch (e) { return fail(e); }
}

export async function conflictAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ conflictId: z.string().uuid(), choice: z.enum(["crm", "sheet"]) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await manager();
    await resolveFieldConflict(c.workspaceId, c.userId, p.data.conflictId, p.data.choice);
    return ok(p.data.choice === "sheet" ? "Took the sheet's value." : "Kept the CRM value.");
  } catch (e) { return fail(e); }
}

export async function saveMappingAction(_p: R, fd: FormData): Promise<R> {
  const g = (k: string) => String(fd.get(k) ?? "").trim();
  const p = z.object({
    mappingId: z.string().uuid(), externalId: z.string().min(1).max(120), name: z.string().min(1).max(120),
    acquiredAt: z.string().max(120), campaign: z.string().max(120), source: z.string().max(120), owner: z.string().max(120), sheetStatus: z.string().max(120),
    headerRow: z.coerce.number().int().min(1).max(20),
  }).safeParse({
    mappingId: g("mappingId"), externalId: g("externalId"), name: g("name"), acquiredAt: g("acquiredAt"), campaign: g("campaign"),
    source: g("source"), owner: g("owner"), sheetStatus: g("sheetStatus"), headerRow: g("headerRow") || "1",
  });
  if (!p.success) return { error: "Choose the lead id column and the name column." };
  const contact = fd.getAll("contact").map(String).map((x) => x.trim()).filter(Boolean).slice(0, 10);
  try {
    const c = await manager();
    await saveMapping(c.workspaceId, c.userId, p.data.mappingId, { ...p.data, contact });
    return ok("Mapping saved. Check the preview, then confirm to import.");
  } catch (e) { return fail(e); }
}
