"use server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireCtx } from "@/lib/session";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_COLUMN_MAP, parseSheetUrl, parseWorksheet } from "@/lib/sheetparse";
import { PermanentSyncError, fetchWorksheetCsv, syncConnection } from "@/lib/sheetsync";
import type { R } from "../actions";


async function manager() {
  const c = await requireCtx();
  if (c.role !== "admin" && c.role !== "manager") throw new PermanentSyncError("Only managers and admins can do this.");
  return c;
}
const fail = (e: unknown): R => {
  if (e instanceof PermanentSyncError) return { error: e.message };
  console.error(e);
  return { error: "Something went wrong. Nothing was changed. Try again." };
};
const ok = (message: string): R => { revalidatePath("/integrations"); revalidatePath("/", "layout"); return { ok: true, message }; };

export async function connectSheetAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ url: z.string().max(500) }).safeParse(Object.fromEntries(fd));
  const parsed = p.success ? parseSheetUrl(p.data.url) : null;
  if (!parsed?.gid) return { error: "Paste the full Google Sheets link of the worksheet tab (it must contain gid=…)." };
  try {
    const c = await manager();
    // Prove the sheet is readable before saving anything.
    const table = await fetchWorksheetCsv(parsed.spreadsheetId, parsed.gid);
    if (!table.length) return { error: "That worksheet is empty." };
    const check = parseWorksheet(table, DEFAULT_COLUMN_MAP, c.tz, fromZonedTime);
    if (check.missingColumns.length) return { error: `This tab is missing expected columns: ${check.missingColumns.join(", ")}. Nothing was connected.` };
    const [conn] = await db.insert(schema.spreadsheetConnection).values({
      workspaceId: c.workspaceId, spreadsheetId: parsed.spreadsheetId, title: "Google Sheet", mode: "read_only",
    }).onConflictDoUpdate({ target: [schema.spreadsheetConnection.workspaceId, schema.spreadsheetConnection.spreadsheetId], set: { healthy: true, lastError: null } })
      .returning({ id: schema.spreadsheetConnection.id });
    await db.insert(schema.worksheetMapping).values({
      connectionId: conn.id, sheetGid: parsed.gid, sheetTitle: `Worksheet ${parsed.gid}`, enabled: true, headerRow: 1,
      columnMap: DEFAULT_COLUMN_MAP, identityStrategy: "source_id_column",
    }).onConflictDoNothing();
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "sheet.connect", entity: "spreadsheet_connection", entityId: conn.id, data: { gid: parsed.gid } });
    return ok("Connected. Review the column mapping below, then confirm to import.");
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
    const s = await syncConnection(row.m.connectionId, "initial", c.userId);
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
    const s = await syncConnection(conn.id, "manual", c.userId);
    return ok(`Sync finished: ${s.created} new, ${s.updated} updated, ${s.skipped} skipped.`);
  } catch (e) { return fail(e); }
}

export async function aliasAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ alias: z.string().min(1).max(80), memberId: z.string().uuid() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Pick a team member." };
  try {
    const c = await manager();
    const [m] = await db.select({ id: schema.workspaceMember.id }).from(schema.workspaceMember)
      .where(and(eq(schema.workspaceMember.id, p.data.memberId), eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true)));
    if (!m) return { error: "That team member is not active." };
    const alias = p.data.alias.trim();
    const [exists] = await db.select({ id: schema.identityAlias.id, memberId: schema.identityAlias.memberId }).from(schema.identityAlias)
      .where(and(eq(schema.identityAlias.workspaceId, c.workspaceId), sql`lower(${schema.identityAlias.alias}) = lower(${alias})`)).limit(1);
    if (exists) await db.update(schema.identityAlias).set({ memberId: m.id, createdBy: c.userId }).where(eq(schema.identityAlias.id, exists.id));
    else await db.insert(schema.identityAlias).values({ workspaceId: c.workspaceId, alias, memberId: m.id, createdBy: c.userId });
    // Resolve only this workspace's conflicts (conflicts belong to a workspace through their connection).
    const mine = db.select({ id: schema.spreadsheetConnection.id }).from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.workspaceId, c.workspaceId));
    await db.update(schema.syncConflict).set({ resolvedAt: new Date(), resolution: `mapped to member ${m.id}` })
      .where(and(inArray(schema.syncConflict.connectionId, mine), eq(schema.syncConflict.field, "unmapped_owner"),
        sql`lower(${schema.syncConflict.sheetValue}) = lower(${alias})`, isNull(schema.syncConflict.resolvedAt)));
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "sheet.alias", entity: "identity_alias", data: { alias, memberId: m.id } });
    return ok("Saved. Future syncs assign this name to that person. Leads already imported can be assigned from the Leads page.");
  } catch (e) { return fail(e); }
}
