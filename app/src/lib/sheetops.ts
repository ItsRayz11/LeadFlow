import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { db, schema } from "@/db";
import { dbTx, type Tx } from "@/db/tx";
import { normalizePhone } from "@/lib/phone";
import { parseWorksheet, type ColumnMap, type ParsedRow } from "@/lib/sheetparse";
import { parseSheetText } from "@/lib/sheetlabels";
import { listTabsApi, serviceAccountConfigured } from "@/lib/sheetsapi";
import { PermanentSyncError, SOURCE_FIELDS, applyProgress, fetchWorksheetCsv, type Base, type SourceField } from "@/lib/sheetsync";

/** Operator actions on sheet data. Kept apart from the sync loop; each is tested against the database. */

const L = schema.lead;

/** Links a sheet name to a team member (creating or updating the alias) and closes this workspace's matching "unmapped" notices. */
export async function linkAlias(workspaceId: string, userId: string, aliasRaw: string, memberId: string) {
  const alias = aliasRaw.trim();
  const [m] = await db.select({ id: schema.workspaceMember.id, role: schema.workspaceMember.role }).from(schema.workspaceMember)
    .where(and(eq(schema.workspaceMember.id, memberId), eq(schema.workspaceMember.workspaceId, workspaceId), eq(schema.workspaceMember.active, true)));
  if (!m) throw new PermanentSyncError("That team member is not active.");
  if (m.role === "viewer") throw new PermanentSyncError("Read-only members cannot own leads.");
  const [exists] = await db.select({ id: schema.identityAlias.id }).from(schema.identityAlias)
    .where(and(eq(schema.identityAlias.workspaceId, workspaceId), sql`lower(${schema.identityAlias.alias}) = lower(${alias})`)).limit(1);
  if (exists) await db.update(schema.identityAlias).set({ memberId: m.id, createdBy: userId }).where(eq(schema.identityAlias.id, exists.id));
  else await db.insert(schema.identityAlias).values({ workspaceId, alias, memberId: m.id, createdBy: userId });
  const mine = db.select({ id: schema.spreadsheetConnection.id }).from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.workspaceId, workspaceId));
  await db.update(schema.syncConflict).set({ resolvedAt: new Date(), resolution: `mapped to member ${m.id}` })
    .where(and(inArray(schema.syncConflict.connectionId, mine), eq(schema.syncConflict.field, "unmapped_owner"),
      sql`lower(${schema.syncConflict.sheetValue}) = lower(${alias})`, isNull(schema.syncConflict.resolvedAt)));
  // Leads imported earlier with this name were left unassigned. Give them to the person now, but never take a lead from someone who already has it.
  const assigned = await db.update(L).set({ ownerId: m.id, updatedAt: new Date(), updatedBy: userId, version: sql`${L.version} + 1` })
    .where(and(eq(L.workspaceId, workspaceId), isNull(L.ownerId), isNull(L.mergedIntoId), sql`lower(${L.custom}->>'ownerNameInSheet') = lower(${alias})`))
    .returning({ id: L.id });
  for (let i = 0; i < assigned.length; i += 200) {
    await db.insert(schema.leadActivity).values(assigned.slice(i, i + 200).map((a) => ({
      leadId: a.id, workspaceId, type: "assigned" as const, actorId: null,
      summary: `Assigned because “${alias}” in the sheet was linked to this person`, idempotencyKey: `assign:alias:${a.id}`,
    }))).onConflictDoNothing();
  }
  // Leads that already sit in a follow-up stage need an open task to show in the follow-up lists. Due later today, never overdue.
  const staged = assigned.length
    ? await db.select({ id: L.id, step: L.followUpStep }).from(L).where(and(inArray(L.id, assigned.map((a) => a.id)), isNull(L.closedAt), inArray(L.followUpStep, ["contact_started", "h24", "h48", "final"])))
    : [];
  const due = new Date(Date.now() + 2 * 3600e3);
  for (let i = 0; i < staged.length; i += 200) {
    const made = await db.insert(schema.followUpTask).values(staged.slice(i, i + 200).map((x) => ({
      workspaceId, leadId: x.id, step: x.step as "contact_started" | "h24" | "h48" | "final", dueAt: due, ownerId: m.id,
      priority: "normal" as const, createdBy: "sheet-sync", dedupeKey: `${x.id}:${x.step}:sheet`,
    }))).onConflictDoNothing().returning({ leadId: schema.followUpTask.leadId });
    if (made.length) await db.update(L).set({ nextFollowUpAt: due }).where(inArray(L.id, made.map((x) => x.leadId)));
  }
  await db.insert(schema.auditLog).values({ workspaceId, actorId: userId, action: "sheet.alias", entity: "identity_alias", data: { alias, memberId: m.id, assigned: assigned.length } });
  return { assigned: assigned.length };
}

/** Settles a CRM-vs-sheet difference. "crm" keeps what the team typed; "sheet" takes the sheet's value. Both are logged. */
export async function resolveFieldConflict(workspaceId: string, userId: string, conflictId: string, choice: "crm" | "sheet") {
  return dbTx.transaction(async (tx) => {
    const [row] = await tx.select({ c: schema.syncConflict }).from(schema.syncConflict)
      .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.syncConflict.connectionId))
      .where(and(eq(schema.syncConflict.id, conflictId), eq(schema.spreadsheetConnection.workspaceId, workspaceId), isNull(schema.syncConflict.resolvedAt)))
      .for("update", { of: schema.syncConflict });
    if (!row) throw new PermanentSyncError("That difference was already settled.");
    const c = row.c;
    const field = c.field as SourceField;
    const isProgress = c.field === "progress"; // status and follow-up stage travel together
    if ((!isProgress && !SOURCE_FIELDS.includes(field)) || !c.leadId) throw new PermanentSyncError("This kind of notice cannot be settled here.");
    const latest = await tx.select({ id: schema.syncConflict.id }).from(schema.syncConflict).where(and(
      eq(schema.syncConflict.leadId, c.leadId), eq(schema.syncConflict.field, c.field), isNull(schema.syncConflict.resolvedAt), sql`${schema.syncConflict.createdAt} > (select s2.created_at from sync_conflict s2 where s2.id = ${c.id})`)).limit(1);
    if (latest.length) throw new PermanentSyncError("The sheet changed again since this difference was recorded. Reload to see the newest one.");
    if (isProgress) {
      await settleProgress(tx, workspaceId, userId, c, choice);
    } else {
      const [lead] = await tx.select().from(L).where(and(eq(L.id, c.leadId), eq(L.workspaceId, workspaceId))).for("update");
      if (!lead) throw new PermanentSyncError("The lead no longer exists.");
      const v = c.sheetValue || null;
      if (choice === "sheet" && field === "name" && !v) throw new PermanentSyncError("A lead needs a name.");
      const cust = (lead.custom ?? {}) as Record<string, unknown> & { sheetBase?: Base };
      // Either way the sheet's latest value becomes the recorded baseline, so the same difference is not raised again.
      const base: Base = { name: lead.name, phoneRaw: lead.phoneRaw, email: lead.email, campaign: lead.campaign, source: lead.source, ...(cust.sheetBase ?? {}), [field]: v };
      if (choice === "sheet") {
        const set: Partial<typeof L.$inferInsert> = { [field]: v } as Partial<typeof L.$inferInsert>;
        if (field === "phoneRaw") set.phoneNorm = normalizePhone(v);
        if (field === "email") set.emailNorm = v ? v.toLowerCase() : null;
        await tx.update(L).set({ ...set, custom: { ...cust, sheetBase: base }, updatedAt: new Date(), updatedBy: userId, version: lead.version + 1 }).where(eq(L.id, lead.id));
        await tx.insert(schema.leadActivity).values({
          leadId: lead.id, workspaceId, type: "edited", actorId: userId,
          summary: `Took the sheet's ${field} after a difference: “${c.crmValue ?? ""}” → “${v ?? ""}”`, data: { field, from: c.crmValue, to: v },
        });
      } else {
        await tx.update(L).set({ custom: { ...cust, sheetBase: base } }).where(eq(L.id, lead.id));
      }
    }
    await tx.update(schema.syncConflict).set({ resolvedAt: new Date(), resolution: choice === "sheet" ? "used sheet value" : "kept CRM value" })
      .where(eq(schema.syncConflict.id, c.id));
    await tx.insert(schema.auditLog).values({ workspaceId, actorId: userId, action: "sheet.conflict", entity: "sync_conflict", entityId: c.id, data: { choice, field } });
    return { leadId: c.leadId, connectionId: c.connectionId };
  });
}

/** "sheet": the lead takes the sheet's status and follow-up stage. "crm": the sheet's current wording becomes the baseline, so the next push writes the CRM state into the sheet. */
async function settleProgress(tx: Tx, workspaceId: string, userId: string, c: typeof schema.syncConflict.$inferSelect, choice: "crm" | "sheet") {
  const [lead] = await tx.select().from(L).where(and(eq(L.id, c.leadId!), eq(L.workspaceId, workspaceId))).for("update");
  if (!lead) throw new PermanentSyncError("The lead no longer exists.");
  const seen = parseSheetText(c.sheetValue ?? "");
  if (choice === "sheet") {
    const [conn] = await tx.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, c.connectionId));
    const row = { sheetStatus: seen.status || null, ownerAlias: null, progress: { stage: seen.stage || null, notes: null, card: null, salesQualified: null, completedMeeting: null, onboarded: null, referralCode: null } } as unknown as ParsedRow;
    await applyProgress(tx, conn, lead.id, row, () => ({ memberId: null, unmapped: false }), new Date(), { assigned: 0, progressed: 0 }, { forced: true });
    await tx.insert(schema.leadActivity).values({
      leadId: lead.id, workspaceId, type: "edited", actorId: userId, summary: `Took the sheet's status and follow-up stage after a difference: “${c.crmValue ?? ""}” → “${c.sheetValue ?? ""}”`,
    });
  } else {
    const cust = (lead.custom ?? {}) as Record<string, unknown>;
    await tx.update(L).set({ custom: { ...cust, sheetProgress: seen } }).where(eq(L.id, lead.id));
  }
}

/** Turns "write status and follow-up stage back to the sheet" on or off for every tab of a two-way connection. */
export async function setProgressWriteback(workspaceId: string, userId: string, connectionId: string, on: boolean) {
  const [conn] = await db.select().from(schema.spreadsheetConnection)
    .where(and(eq(schema.spreadsheetConnection.id, connectionId), eq(schema.spreadsheetConnection.workspaceId, workspaceId)));
  if (!conn) throw new PermanentSyncError("Connection not found.");
  if (on && conn.mode !== "two_way") throw new PermanentSyncError("Turn on two-way sync first.");
  await db.update(schema.worksheetMapping).set({ valueMaps: sql`coalesce(${schema.worksheetMapping.valueMaps}, '{}'::jsonb) || jsonb_build_object('writeProgress', ${on}::boolean)` })
    .where(eq(schema.worksheetMapping.connectionId, conn.id));
  await db.insert(schema.auditLog).values({ workspaceId, actorId: userId, action: "sheet.progress_writeback", entity: "spreadsheet_connection", entityId: conn.id, data: { on } });
}

/** Switches a connection between read-only import and two-way sync. Turning two-way on needs the service account and Editor access. */
export async function setSyncMode(workspaceId: string, userId: string, connectionId: string, mode: "read_only" | "two_way") {
  const [conn] = await db.select().from(schema.spreadsheetConnection)
    .where(and(eq(schema.spreadsheetConnection.id, connectionId), eq(schema.spreadsheetConnection.workspaceId, workspaceId)));
  if (!conn) throw new PermanentSyncError("Connection not found.");
  if (mode === "two_way") {
    if (!serviceAccountConfigured()) throw new PermanentSyncError("Two-way sync needs the Google service account. Add GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY to the server settings first.");
    try { await listTabsApi(conn.spreadsheetId, undefined, true); }
    catch (e) { throw new PermanentSyncError(e instanceof Error ? e.message : "Google Sheets could not be reached."); }
    // This proves the sheet is readable by the service account. Editor access is only proven by the first write; a failure shows on the connection.
  }
  await db.update(schema.spreadsheetConnection).set({ mode }).where(eq(schema.spreadsheetConnection.id, conn.id));
  await db.insert(schema.auditLog).values({ workspaceId, actorId: userId, action: "sheet.mode", entity: "spreadsheet_connection", entityId: conn.id, data: { mode } });
}

/** Validates and saves a column mapping. Changing the id column after import would re-create every lead, so it is blocked. */
export async function saveMapping(workspaceId: string, userId: string, mappingId: string, input: ColumnMap & { headerRow?: number }) {
  const [row] = await db.select({ m: schema.worksheetMapping, c: schema.spreadsheetConnection }).from(schema.worksheetMapping)
    .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.worksheetMapping.connectionId))
    .where(and(eq(schema.worksheetMapping.id, mappingId), eq(schema.spreadsheetConnection.workspaceId, workspaceId)));
  if (!row) throw new PermanentSyncError("Worksheet not found.");
  if (!input.externalId || !input.name) throw new PermanentSyncError("The lead id and name columns are required.");
  const table = await fetchWorksheetCsv(row.c.spreadsheetId, row.m.sheetGid);
  const headerRow = Math.min(Math.max(input.headerRow ?? row.m.headerRow, 1), 20);
  const norm = (h: string) => h.replace(/\s+/g, " ").trim().toLowerCase();
  const headers = (table[headerRow - 1] ?? []).map(norm);
  // Phone/email columns are optional hints (a tab may have only some of them); the others must exist.
  const bad = [input.externalId, input.name, input.acquiredAt, input.campaign, input.source, input.owner, input.sheetStatus]
    .filter((h): h is string => !!h && !headers.includes(norm(h)));
  if (bad.length) throw new PermanentSyncError(`These columns are not in row ${headerRow} of the sheet: ${bad.join(", ")}`);
  const old = row.m.columnMap as Partial<ColumnMap>;
  if (old.externalId && norm(old.externalId) !== norm(input.externalId)) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(L).where(and(eq(L.connectionId, row.c.id), eq(L.sheetGid, row.m.sheetGid)));
    if (n > 0) throw new PermanentSyncError("Leads were already imported using the current id column. Changing it would duplicate them, so it is locked.");
  }
  const contactPresent = input.contact.filter((h) => headers.includes(norm(h)));
  if (!contactPresent.length) throw new PermanentSyncError("Pick at least one phone or email column that exists in the sheet. Leaving none would blank every lead's contact details.");
  const columnMap: ColumnMap = {
    externalId: input.externalId, name: input.name, acquiredAt: input.acquiredAt || undefined, campaign: input.campaign || undefined,
    source: input.source || undefined, owner: input.owner || undefined, sheetStatus: input.sheetStatus || undefined,
    contact: contactPresent,
  };
  // A changed mapping must be looked at again before it imports anything.
  await db.update(schema.worksheetMapping).set({ columnMap, headerRow, confirmedAt: null }).where(eq(schema.worksheetMapping.id, row.m.id));
  await db.insert(schema.auditLog).values({ workspaceId, actorId: userId, action: "sheet.mapping", entity: "worksheet_mapping", entityId: row.m.id, data: { columnMap, headerRow } });
}

/** Header list and a few parsed sample rows, so a manager can check the mapping before anything is imported. */
export async function previewWorksheet(spreadsheetId: string, gid: string, map: ColumnMap, headerRow: number, tz: string) {
  const table = await fetchWorksheetCsv(spreadsheetId, gid);
  const headers = (table[Math.max(0, headerRow - 1)] ?? []).map((h) => h.trim()).filter(Boolean);
  const parsed = parseWorksheet(table, map, tz, fromZonedTime, Math.max(0, headerRow - 1));
  return { headers: [...new Set(headers)], valid: parsed.rows.length, skipped: parsed.skipped, missing: parsed.missingColumns, sample: parsed.rows.slice(0, 3) };
}
