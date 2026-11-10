import "server-only";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db, schema } from "@/db";
import { DEFAULT_COLUMN_MAP, indexesOf, type ColumnMap } from "@/lib/sheetparse";
import { buildNewRow, indexRows, planLeadWrites, type Values, type WriteField } from "@/lib/sheetplan";
import { SheetsAccessError, SheetsTransientError, appendRowsApi, readTableApi, serviceAccountConfigured, writeCellsApi } from "@/lib/sheetsapi";

/**
 * Writes CRM changes back to the Google Sheet (two-way mode only).
 *
 * There is no queue: a lead needs writing exactly when one of its source fields differs from `custom.sheetBase`
 * (what the sheet last said). That makes every run safe to repeat and every failure self-healing. The next run simply tries again.
 */

const L = schema.lead;
const BATCH = 200;

export type PushSummary = { updated: number; adopted: number; conflicts: number; appended: number; skipped: number; errors: string[] };
const empty = (): PushSummary => ({ updated: 0, adopted: 0, conflicts: 0, appended: 0, skipped: 0, errors: [] });

const colMap = (m: { columnMap: unknown }) => ({ ...DEFAULT_COLUMN_MAP, ...(m.columnMap as Partial<ColumnMap>) }) as ColumnMap;
const crmValues = (l: typeof L.$inferSelect): Values => ({ name: l.name, phoneRaw: l.phoneRaw, email: l.email, campaign: l.campaign, source: l.source });
const asValues = (b: unknown): Values => {
  const o = (b ?? {}) as Record<string, string | null | undefined>;
  return { name: o.name ?? null, phoneRaw: o.phoneRaw ?? null, email: o.email ?? null, campaign: o.campaign ?? null, source: o.source ?? null };
};
const errText = (e: unknown) => (e instanceof Error ? e.message : "failed");

/** Moves the recorded "what the sheet says" baseline for some fields, without touching anything else on the lead. */
async function setBaseline(leadId: string, entries: [WriteField, string | null][]) {
  if (!entries.length) return;
  let expr = sql`coalesce(${L.custom}, '{}'::jsonb)`;
  for (const [f, v] of entries) {
    expr = sql`jsonb_set(${expr}, ${`{sheetBase,${f}}`}::text[], ${v === null ? sql`'null'::jsonb` : sql`to_jsonb(${v}::text)`}, true)`;
  }
  await db.update(L).set({ custom: expr }).where(eq(L.id, leadId));
}

/** Pushes pending CRM edits for one connection (or just one lead) into the sheet. Fields changed on both sides become conflicts. */
export async function pushConnection(connectionId: string, opts: { leadId?: string; deadline?: number } = {}): Promise<PushSummary> {
  const out = empty();
  if (!serviceAccountConfigured()) return out;
  const [conn] = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connectionId));
  if (!conn || conn.mode !== "two_way") return out;
  const maps = await db.select().from(schema.worksheetMapping).where(and(
    eq(schema.worksheetMapping.connectionId, conn.id), eq(schema.worksheetMapping.enabled, true)));

  for (const m of maps.filter((x) => x.confirmedAt)) {
    try {
      const pending = await db.select().from(L).where(and(
        eq(L.connectionId, conn.id), eq(L.sheetGid, m.sheetGid), sql`${L.externalId} is not null`, isNull(L.mergedIntoId),
        sql`${L.custom}->'sheetBase' is not null`,
        sql`(${L.name} is distinct from ${L.custom}->'sheetBase'->>'name'
          or ${L.phoneRaw} is distinct from ${L.custom}->'sheetBase'->>'phoneRaw'
          or ${L.email} is distinct from ${L.custom}->'sheetBase'->>'email'
          or ${L.campaign} is distinct from ${L.custom}->'sheetBase'->>'campaign'
          or ${L.source} is distinct from ${L.custom}->'sheetBase'->>'source')`,
        opts.leadId ? eq(L.id, opts.leadId) : undefined,
      )).limit(BATCH);
      if (!pending.length) continue; // nothing to write: do not even read the sheet

      const map = colMap(m);
      const headerRow = Math.max(0, m.headerRow - 1);
      const table = await readTableApi(conn.spreadsheetId, m.sheetGid, opts.deadline);
      const headers = (table[headerRow] ?? []).map((h) => h ?? "");
      const rows = indexRows(table, headerRow, indexesOf(headers, map.externalId));

      const open = await db.select({ leadId: schema.syncConflict.leadId, field: schema.syncConflict.field }).from(schema.syncConflict).where(and(
        eq(schema.syncConflict.connectionId, conn.id), isNull(schema.syncConflict.resolvedAt), inArray(schema.syncConflict.leadId, pending.map((p) => p.id))));
      const openBy = new Map<string, Set<string>>();
      for (const o of open) if (o.leadId) openBy.set(o.leadId, (openBy.get(o.leadId) ?? new Set()).add(o.field));

      const cells: { row: number; col: number; value: string }[] = [];
      const after: { lead: typeof L.$inferSelect; entries: [WriteField, string | null][]; wrote: WriteField[] }[] = [];
      for (const lead of pending) {
        const row = rows.get((lead.externalId ?? "").trim());
        if (!row) { out.skipped++; continue; } // the row was deleted or its id changed; the lead stays in the CRM
        const crm = crmValues(lead);
        const plans = planLeadWrites({
          table, headerRow, rowNumber: row, map, base: asValues((lead.custom as { sheetBase?: unknown }).sheetBase), crm, openConflicts: openBy.get(lead.id) ?? new Set(),
        });
        const entries: [WriteField, string | null][] = [], wrote: WriteField[] = [];
        for (const p of plans) {
          if (p.kind === "write") { cells.push({ row, col: p.col, value: p.value }); entries.push([p.field, crm[p.field]]); wrote.push(p.field); }
          else if (p.kind === "adopt") { entries.push([p.field, crm[p.field]]); out.adopted++; }
          else if (p.kind === "conflict") {
            await db.insert(schema.syncConflict).values({ connectionId: conn.id, leadId: lead.id, field: p.field, sheetValue: p.sheetValue, crmValue: p.crmValue });
            out.conflicts++;
          } else out.skipped++;
        }
        if (entries.length) after.push({ lead, entries, wrote });
      }

      // Write first, then move baselines. If the write fails nothing is recorded, so the next run retries it.
      for (let i = 0; i < cells.length; i += 400) await writeCellsApi(conn.spreadsheetId, m.sheetGid, cells.slice(i, i + 400), opts.deadline);
      for (const a of after) {
        await setBaseline(a.lead.id, a.entries);
        if (a.wrote.length) {
          out.updated++;
          await db.insert(schema.leadActivity).values({
            leadId: a.lead.id, workspaceId: conn.workspaceId, type: "synced", actorId: null,
            summary: `Wrote to the sheet: ${a.wrote.join(", ")}`, idempotencyKey: `push:${a.lead.id}:${a.lead.version}:${a.wrote.join(",")}`,
          }).onConflictDoNothing();
        }
      }
    } catch (e) {
      out.errors.push(`“${m.sheetTitle}”: ${errText(e)}`);
      if (!(e instanceof SheetsAccessError || e instanceof SheetsTransientError)) console.error("sheet write-back", e);
    }
  }
  return out;
}

/** Best-effort push right after a lead is edited, so the sheet updates in seconds. The periodic run covers any failure. */
export async function pushLeadNow(leadId: string): Promise<void> {
  try {
    const [l] = await db.select({ c: L.connectionId }).from(L).where(eq(L.id, leadId));
    if (l?.c) await pushConnection(l.c, { leadId, deadline: Date.now() + 20_000 });
  } catch (e) { console.error("push lead", e); }
}

/** Adds one CRM-created lead as a new row at the end of the first connected tab of a two-way sheet. Safe to repeat. */
export async function appendLeadToSheet(leadId: string, deadline?: number): Promise<"added" | "none" | "failed"> {
  if (!serviceAccountConfigured()) return "none";
  try {
    const [lead] = await db.select().from(L).where(and(eq(L.id, leadId), isNull(L.connectionId), isNull(L.externalId), isNull(L.mergedIntoId)));
    if (!lead || lead.createdBy === "sheet-sync") return "none";
    const [target] = await db.select({ conn: schema.spreadsheetConnection, m: schema.worksheetMapping }).from(schema.worksheetMapping)
      .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.worksheetMapping.connectionId))
      .where(and(eq(schema.spreadsheetConnection.workspaceId, lead.workspaceId), eq(schema.spreadsheetConnection.mode, "two_way"),
        eq(schema.worksheetMapping.enabled, true), sql`${schema.worksheetMapping.confirmedAt} is not null`))
      .orderBy(schema.spreadsheetConnection.createdAt, schema.worksheetMapping.sheetTitle).limit(1);
    if (!target) return "none";
    const [ws] = await db.select({ tz: schema.workspace.timezone }).from(schema.workspace).where(eq(schema.workspace.id, lead.workspaceId));
    const map = colMap(target.m);
    const headerRow = Math.max(0, target.m.headerRow - 1);
    const table = await readTableApi(target.conn.spreadsheetId, target.m.sheetGid, deadline);
    const headers = (table[headerRow] ?? []).map((h) => h ?? "");
    const externalId = `crm-${lead.id.replace(/-/g, "").slice(0, 12)}`;
    const exists = indexRows(table, headerRow, indexesOf(headers, map.externalId)).has(externalId); // an earlier attempt may have written the row already
    if (!exists) {
      const row = buildNewRow(headers, map, {
        externalId, name: lead.name, phone: lead.phoneRaw, email: lead.email, campaign: lead.campaign, source: lead.source,
        created: formatInTimeZone(lead.acquiredAt, ws?.tz ?? "UTC", "yyyy-MM-dd HH:mm"),
      });
      if (!row) return "failed";
      await appendRowsApi(target.conn.spreadsheetId, target.m.sheetGid, [row], deadline);
    }
    const cust = (lead.custom ?? {}) as Record<string, unknown>;
    await db.update(L).set({
      connectionId: target.conn.id, sheetGid: target.m.sheetGid, externalId, lastSyncedAt: new Date(),
      sourceUrl: `https://docs.google.com/spreadsheets/d/${target.conn.spreadsheetId}/edit?gid=${target.m.sheetGid}`,
      custom: { ...cust, sheetBase: crmValues(lead) },
    }).where(and(eq(L.id, lead.id), isNull(L.connectionId)));
    await db.insert(schema.leadActivity).values({
      leadId: lead.id, workspaceId: lead.workspaceId, type: "synced", actorId: null,
      summary: `Added to the sheet “${target.conn.title ?? "Google Sheet"}”`, idempotencyKey: `append:${lead.id}`,
    }).onConflictDoNothing();
    return "added";
  } catch (e) {
    console.error("append lead to sheet", e);
    return "failed";
  }
}

/** Runs write-back for every two-way connection, then retries recent CRM-created leads that never reached the sheet. */
export async function pushAllTwoWay(budgetMs = 20_000): Promise<PushSummary> {
  const deadline = Date.now() + budgetMs;
  const total = empty();
  if (!serviceAccountConfigured()) return total;
  const conns = await db.select({ id: schema.spreadsheetConnection.id, ws: schema.spreadsheetConnection.workspaceId }).from(schema.spreadsheetConnection)
    .where(eq(schema.spreadsheetConnection.mode, "two_way"));
  for (const c of conns) {
    if (Date.now() > deadline) break;
    const r = await pushConnection(c.id, { deadline });
    for (const k of ["updated", "adopted", "conflicts", "appended", "skipped"] as const) total[k] += r[k];
    total.errors.push(...r.errors);
  }
  const wsIds = [...new Set(conns.map((c) => c.ws))];
  if (wsIds.length) {
    const recent = await db.select({ id: L.id }).from(L).where(and(
      inArray(L.workspaceId, wsIds), isNull(L.connectionId), isNull(L.externalId), isNull(L.mergedIntoId),
      ne(L.createdBy, "sheet-sync"), gt(L.createdAt, new Date(Date.now() - 24 * 3600e3)))).limit(20);
    for (const l of recent) {
      if (Date.now() > deadline) break;
      if ((await appendLeadToSheet(l.id, deadline)) === "added") total.appended++;
    }
  }
  return total;
}
