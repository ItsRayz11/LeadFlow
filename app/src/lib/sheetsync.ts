import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { db, schema } from "@/db";
import { dbTx } from "@/db/tx";
import { notify } from "@/lib/notify";
import { dueFor, readSettings } from "@/lib/schedule";
import { DEFAULT_COLUMN_MAP, parseCsv, parseWorksheet, type ColumnMap, type ParsedRow } from "@/lib/sheetparse";

const L = schema.lead;
const CHUNK = 200;
const MAX_BYTES = 15 * 1024 * 1024;

const hashRow = (r: ParsedRow) =>
  createHash("sha256").update(JSON.stringify([r.name, r.phoneRaw, r.email, r.campaign, r.source])).digest("hex").slice(0, 32);

/**
 * Reads one worksheet as CSV through Google's export endpoint. This works for sheets shared by link and needs no credentials.
 * A private sheet returns an HTML sign-in page, which is detected and reported as a clear, recoverable error
 * (the OAuth reader replaces this function once Google credentials exist).
 */
export async function fetchWorksheetCsv(spreadsheetId: string, gid: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000), redirect: "follow", cache: "no-store" });
      if (res.status === 429 || res.status >= 500) throw new Error(`Google returned ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.includes("csv")) throw new PermanentSyncError("The sheet is not readable. Share it as “anyone with the link can view” or connect with Google.");
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new PermanentSyncError("The worksheet is larger than 15 MB.");
      return parseCsv(text);
    } catch (e) {
      if (e instanceof PermanentSyncError) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // exponential backoff
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Google could not be reached.");
}

export class PermanentSyncError extends Error {}

export type SyncSummary = { seen: number; created: number; updated: number; skipped: number; assigned: number; possibleDuplicates: number; skippedReasons: string[] };

/** Matches sheet names to people: explicit admin aliases first, then an exact (case-insensitive) display name. */
async function ownerResolver(workspaceId: string) {
  const members = await db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName, role: schema.workspaceMember.role })
    .from(schema.workspaceMember).where(and(eq(schema.workspaceMember.workspaceId, workspaceId), eq(schema.workspaceMember.active, true)));
  const aliases = await db.select().from(schema.identityAlias).where(eq(schema.identityAlias.workspaceId, workspaceId));
  const ok = new Map(members.filter((m) => m.role !== "viewer").map((m) => [m.id, m]));
  const byAlias = new Map(aliases.map((a) => [a.alias.toLowerCase(), a.memberId]));
  const byName = new Map(members.map((m) => [m.name.trim().toLowerCase(), m.id]));
  return (alias: string | null): { memberId: string | null; unmapped: boolean } => {
    if (!alias) return { memberId: null, unmapped: false };
    const k = alias.toLowerCase();
    if (byAlias.has(k)) { const id = byAlias.get(k) ?? null; return { memberId: id && ok.has(id) ? id : null, unmapped: false }; }
    const id = byName.get(k);
    return id && ok.has(id) ? { memberId: id, unmapped: false } : { memberId: null, unmapped: true };
  };
}

export async function syncConnection(connectionId: string, trigger: "manual" | "cron" | "initial", actorUserId?: string): Promise<SyncSummary> {
  const [conn] = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connectionId));
  if (!conn) throw new Error("Connection not found");
  const [ws] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, conn.workspaceId));
  const settings = readSettings(ws.settings);
  const maps = await db.select().from(schema.worksheetMapping)
    .where(and(eq(schema.worksheetMapping.connectionId, conn.id), eq(schema.worksheetMapping.enabled, true)));

  const [job] = await db.insert(schema.syncJob).values({ connectionId: conn.id, trigger, status: "running" }).returning();
  const total: SyncSummary = { seen: 0, created: 0, updated: 0, skipped: 0, assigned: 0, possibleDuplicates: 0, skippedReasons: [] };
  const errors: string[] = [];

  try {
    const resolve = await ownerResolver(conn.workspaceId);
    for (const m of maps) {
      try {
        if (!m.confirmedAt) { errors.push(`“${m.sheetTitle}”: mapping not confirmed`); continue; }
        const table = await fetchWorksheetCsv(conn.spreadsheetId, m.sheetGid);
        const map = { ...DEFAULT_COLUMN_MAP, ...(m.columnMap as Partial<ColumnMap>) } as ColumnMap;
        const parsed = parseWorksheet(table, map, ws.timezone, fromZonedTime, Math.max(0, m.headerRow - 1));
        if (parsed.missingColumns.length) { errors.push(`“${m.sheetTitle}”: columns not found: ${parsed.missingColumns.join(", ")}`); continue; }
        const part = await ingest(conn, ws, settings, m.sheetGid, parsed.rows, resolve);
        total.seen += parsed.rows.length + parsed.skipped.reduce((a, s) => a + s.count, 0);
        total.skipped += parsed.skipped.reduce((a, s) => a + s.count, 0);
        total.skippedReasons.push(...parsed.skipped.map((s) => `${s.count} × ${s.reason}`));
        for (const k of ["created", "updated", "assigned", "possibleDuplicates"] as const) total[k] += part[k];
      } catch (e) {
        errors.push(`“${m.sheetTitle}”: ${e instanceof Error ? e.message : "failed"}`);
        if (!(e instanceof PermanentSyncError)) console.error("sheet sync", e);
      }
    }
    const failed = errors.length > 0;
    const status = !failed ? "success" : maps.length > errors.length ? "partial" : "failed";
    await db.update(schema.syncJob).set({
      status, finishedAt: new Date(), rowsSeen: total.seen, rowsCreated: total.created, rowsUpdated: total.updated, rowsSkipped: total.skipped,
      error: failed ? errors.join("\n").slice(0, 1500) : null,
    }).where(eq(schema.syncJob.id, job.id));
    await db.update(schema.spreadsheetConnection).set(
      failed ? { healthy: false, lastError: errors.join("\n").slice(0, 1500) }
        : { healthy: true, lastError: null, lastSuccessfulSyncAt: new Date() },
    ).where(eq(schema.spreadsheetConnection.id, conn.id));
    if (trigger === "manual" && actorUserId) {
      await db.insert(schema.auditLog).values({ workspaceId: conn.workspaceId, actorId: actorUserId, action: "sheet.sync", entity: "spreadsheet_connection", entityId: conn.id, data: { ...total } });
    }
    return total;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    await db.update(schema.syncJob).set({ status: "failed", finishedAt: new Date(), error: msg.slice(0, 1500) }).where(eq(schema.syncJob.id, job.id));
    await db.update(schema.spreadsheetConnection).set({ healthy: false, lastError: msg.slice(0, 1500) }).where(eq(schema.spreadsheetConnection.id, conn.id));
    throw e;
  }
}

async function ingest(
  conn: typeof schema.spreadsheetConnection.$inferSelect, ws: typeof schema.workspace.$inferSelect,
  settings: ReturnType<typeof readSettings>, gid: string, rows: ParsedRow[], resolve: Awaited<ReturnType<typeof ownerResolver>>,
) {
  const out = { created: 0, updated: 0, assigned: 0, possibleDuplicates: 0 };
  const now = new Date();

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ids = chunk.map((r) => r.externalId);
    const existing = await db.select({ id: L.id, externalId: L.externalId, hash: L.sourceRowHash })
      .from(L).where(and(eq(L.connectionId, conn.id), eq(L.sheetGid, gid), inArray(L.externalId, ids)));
    const have = new Map(existing.map((e) => [e.externalId!, e]));

    const fresh = chunk.filter((r) => !have.has(r.externalId));
    const changed = chunk.filter((r) => { const e = have.get(r.externalId); return e && e.hash !== hashRow(r); });

    // Possible duplicates: same phone or email already known in this workspace under a different source id.
    const phones = [...new Set(fresh.map((r) => r.phoneNorm).filter((x): x is string => !!x))];
    const emails = [...new Set(fresh.map((r) => r.emailNorm).filter((x): x is string => !!x))];
    const dupes = phones.length || emails.length
      ? await db.select({ id: L.id, phone: L.phoneNorm, email: L.emailNorm }).from(L).where(and(
          eq(L.workspaceId, conn.workspaceId), isNull(L.mergedIntoId),
          sql`(${phones.length ? inArray(L.phoneNorm, phones) : sql`false`} or ${emails.length ? inArray(L.emailNorm, emails) : sql`false`})`))
      : [];
    const dupOf = (r: ParsedRow) => dupes.find((d) => (r.phoneNorm && d.phone === r.phoneNorm) || (r.emailNorm && d.email === r.emailNorm))?.id ?? null;

    await dbTx.transaction(async (tx) => {
      if (fresh.length) {
        const planned = fresh.map((r) => {
          const id = randomUUID();
          const { memberId } = resolve(r.ownerAlias);
          const due = memberId ? dueFor("contact_started", now, now, settings) : null;
          return { r, id, memberId, due, dup: dupOf(r) };
        });
        const inserted = await tx.insert(L).values(planned.map((p) => ({
          id: p.id, workspaceId: conn.workspaceId, name: p.r.name, phoneRaw: p.r.phoneRaw, phoneNorm: p.r.phoneNorm,
          email: p.r.email, emailNorm: p.r.emailNorm, source: p.r.source, campaign: p.r.campaign,
          ownerId: p.memberId, followUpStep: "contact_started" as const, nextFollowUpAt: p.due,
          acquiredAt: p.r.acquiredAt ?? now, importedAt: now, connectionId: conn.id, sheetGid: gid, externalId: p.r.externalId,
          sourceRowHash: hashRow(p.r), sourceRaw: p.r.raw, sourceUrl: `https://docs.google.com/spreadsheets/d/${conn.spreadsheetId}/edit?gid=${gid}`,
          custom: { sheetStatus: p.r.sheetStatus, ownerNameInSheet: p.r.ownerAlias, ...(p.dup ? { possibleDuplicateOf: p.dup } : {}) },
          lastSyncedAt: now, createdBy: "sheet-sync", updatedBy: "sheet-sync",
        }))).onConflictDoNothing().returning({ id: L.id });
        const made = new Set(inserted.map((x) => x.id));
        for (const p of planned) {
          if (!made.has(p.id)) continue; // a concurrent sync inserted it first
          out.created++;
          await tx.insert(schema.leadActivity).values({
            leadId: p.id, workspaceId: conn.workspaceId, type: "imported", actorId: null,
            summary: `Imported from “${conn.title ?? "Google Sheet"}”`, data: { externalId: p.r.externalId }, idempotencyKey: `import:${p.r.externalId}`,
          }).onConflictDoNothing();
          if (p.dup) {
            out.possibleDuplicates++;
            await tx.insert(schema.leadActivity).values({
              leadId: p.id, workspaceId: conn.workspaceId, type: "note", actorId: null,
              summary: "Possible duplicate: the same phone or email already exists on another lead. Nothing was merged.", data: { otherLeadId: p.dup }, idempotencyKey: `dup:${p.r.externalId}`,
            }).onConflictDoNothing();
          }
          if (p.memberId && p.due) {
            out.assigned++;
            await tx.insert(schema.followUpTask).values({
              workspaceId: conn.workspaceId, leadId: p.id, step: "contact_started", dueAt: p.due, ownerId: p.memberId,
              priority: "normal", createdBy: "sheet-sync", dedupeKey: `${p.id}:contact_started:0`,
            }).onConflictDoNothing();
            await tx.insert(schema.leadActivity).values({
              leadId: p.id, workspaceId: conn.workspaceId, type: "assigned", actorId: null,
              summary: `Assigned from the sheet owner column (“${p.r.ownerAlias}”)`, idempotencyKey: `assign:import:${p.r.externalId}`,
            }).onConflictDoNothing();
            await notify(tx, { workspaceId: conn.workspaceId, memberId: p.memberId, kind: "assignment", title: `New lead: ${p.r.name}`, leadId: p.id, dedupeKey: `assign:import:${p.id}` });
          } else if (p.r.ownerAlias && resolve(p.r.ownerAlias).unmapped) {
            const [open] = await tx.select({ id: schema.syncConflict.id }).from(schema.syncConflict).where(and(
              eq(schema.syncConflict.connectionId, conn.id), eq(schema.syncConflict.field, "unmapped_owner"),
              eq(schema.syncConflict.sheetValue, p.r.ownerAlias), isNull(schema.syncConflict.resolvedAt))).limit(1);
            if (!open) await tx.insert(schema.syncConflict).values({ connectionId: conn.id, leadId: p.id, field: "unmapped_owner", sheetValue: p.r.ownerAlias, crmValue: null });
          }
        }
      }

      // Updates touch only source-owned fields. Status, owner, tasks, notes and milestones belong to the CRM and are never overwritten.
      for (const r of changed) {
        const e = have.get(r.externalId)!;
        await tx.update(L).set({
          name: r.name, phoneRaw: r.phoneRaw, phoneNorm: r.phoneNorm, email: r.email, emailNorm: r.emailNorm,
          source: r.source, campaign: r.campaign, sourceRowHash: hashRow(r), sourceRaw: r.raw, lastSyncedAt: now, updatedAt: now, updatedBy: "sheet-sync",
        }).where(eq(L.id, e.id));
        await tx.insert(schema.leadActivity).values({
          leadId: e.id, workspaceId: conn.workspaceId, type: "synced", actorId: null, summary: "Contact details updated from the sheet",
          idempotencyKey: `sync:${e.id}:${hashRow(r)}`,
        }).onConflictDoNothing();
        out.updated++;
      }
    });
  }
  return out;
}

/** Runs every healthy-or-recoverable connection. Called by the worker; one failing sheet never blocks the others. */
export async function syncAllConnections(): Promise<{ connections: number; created: number; failed: number }> {
  const conns = await db.select({ id: schema.spreadsheetConnection.id }).from(schema.spreadsheetConnection);
  const r = { connections: conns.length, created: 0, failed: 0 };
  for (const c of conns) {
    try { r.created += (await syncConnection(c.id, "cron")).created; } catch { r.failed++; }
  }
  return r;
}
