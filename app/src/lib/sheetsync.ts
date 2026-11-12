import "server-only";
import { isPlaceholderTitle } from "@/lib/tabs";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { db, schema } from "@/db";
import { dbTx, type Tx } from "@/db/tx";
import { notify } from "@/lib/notify";
import { dueFor, readSettings } from "@/lib/schedule";
import { clean, mayApplyProgress, planProgress, stateOf, type ProgressBase } from "@/lib/sheetprogress";
import { sheetText, type Seen } from "@/lib/sheetlabels";
import { SheetsAccessError, SheetsTransientError, listTabsApi, readTableApi, serviceAccountConfigured } from "@/lib/sheetsapi";
import { DEFAULT_COLUMN_MAP, parseCsv, parseTabList, parseWorksheet, type ColumnMap, type ParsedRow } from "@/lib/sheetparse";

const L = schema.lead;
const CHUNK = 200;
const MAX_BYTES = 15 * 1024 * 1024;
const RECENT_LEAD_MS = 7 * 86_400_000; // only fresh leads get an immediate contact task on import
/** Fields the sheet may update, and only while the CRM value is still the one the sheet last wrote. */
export const SOURCE_FIELDS = ["name", "phoneRaw", "email", "campaign", "source"] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];
export type Base = Record<SourceField, string | null>;

/** Bump when the importer learns to read something new: every row is then read once more, and nothing else changes. */
const HASH_VERSION = 3;
const hashRow = (r: ParsedRow) =>
  createHash("sha256").update(JSON.stringify([HASH_VERSION, r.name, r.phoneRaw, r.email, r.campaign, r.source, r.sheetStatus, r.ownerAlias, r.progress])).digest("hex").slice(0, 32);
const baseOf = (r: ParsedRow): Base => ({ name: r.name, phoneRaw: r.phoneRaw, email: r.email, campaign: r.campaign, source: r.source });

export class PermanentSyncError extends Error {}
/** Ran out of the time budget. Not a sheet fault: the job is marked partial and the next run carries on. */
export class BudgetError extends Error {}

/**
 * Reads one worksheet as CSV through Google's export endpoint. This works for sheets shared by link and needs no credentials.
 * A private sheet returns an HTML sign-in page, which is reported as a clear, recoverable error
 * (the OAuth reader replaces this function once Google credentials exist).
 */
export async function fetchWorksheetCsv(spreadsheetId: string, gid: string, deadline?: number): Promise<string[][]> {
  // Preferred: the Sheets API as the service account, which also works for private sheets.
  // Not shared with it? Fall back to the public CSV link so existing link-shared connections keep working.
  if (serviceAccountConfigured()) {
    try { return await readTableApi(spreadsheetId, gid, deadline); }
    catch (e) {
      if (e instanceof SheetsAccessError) {
        try { return await fetchCsv(spreadsheetId, gid, deadline); }
        catch (e2) { throw e2 instanceof PermanentSyncError ? new PermanentSyncError(e.message) : e2; } // the API message says how to fix access
      }
      throw apiFailure(e, deadline);
    }
  }
  return fetchCsv(spreadsheetId, gid, deadline);
}

/** Turns a temporary Sheets API failure into the errors the sync loop understands. */
export function apiFailure(e: unknown, deadline?: number): unknown {
  if (e instanceof SheetsTransientError) return deadline && Date.now() > deadline - 2_000 ? new BudgetError(e.message) : new Error(e.message);
  if (e instanceof SheetsAccessError) return new PermanentSyncError(e.message);
  return e;
}

async function fetchCsv(spreadsheetId: string, gid: string, deadline?: number): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline ? deadline - Date.now() : 15_000;
    if (left < 2_000) throw new BudgetError("Out of time for this run; the next run continues.");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(15_000, left)), redirect: "follow", cache: "no-store" });
      if (res.status === 429 || res.status >= 500) throw new Error(`Google returned ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.includes("csv")) throw new PermanentSyncError("The sheet is not readable. Share it as “anyone with the link can view” or connect with Google.");
      if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new PermanentSyncError("The worksheet is larger than 15 MB.");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) throw new PermanentSyncError("The worksheet is larger than 15 MB.");
      return parseCsv(buf.toString("utf8"));
    } catch (e) {
      if (e instanceof PermanentSyncError || e instanceof BudgetError) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // exponential backoff
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Google could not be reached.");
}

/** Lists the tabs of a link-shared spreadsheet (needs no credentials). Throws a clear error when the sheet is private or the list cannot be found. */
export async function fetchTabList(spreadsheetId: string): Promise<{ gid: string; title: string }[]> {
  let apiMessage: string | null = null;
  if (serviceAccountConfigured()) {
    try { const tabs = await listTabsApi(spreadsheetId, undefined, true); if (tabs.length) return tabs; }
    catch (e) { if (!(e instanceof SheetsAccessError)) throw apiFailure(e); apiMessage = e.message; } // not shared with the service account: try the public page
  }
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/htmlview`;
  let res: Response;
  try { res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow", cache: "no-store", headers: { "user-agent": "Mozilla/5.0" } }); }
  catch { throw new Error("Google could not be reached. Try again."); }
  const html = res.ok ? (await res.text()).slice(0, 3 * 1024 * 1024) : "";
  const tabs = parseTabList(html);
  if (!tabs.length) throw new PermanentSyncError(apiMessage ?? "Could not list the tabs of this sheet. Make sure it is shared as “anyone with the link can view”, or connect one tab at a time.");
  return tabs;
}

export type SyncSummary = {
  seen: number; created: number; updated: number; skipped: number; assigned: number; possibleDuplicates: number; conflicts: number; progressed: number;
  skippedReasons: string[]; ran: boolean; partial?: boolean;
};
const emptySummary = (): SyncSummary => ({ seen: 0, created: 0, updated: 0, skipped: 0, assigned: 0, possibleDuplicates: 0, conflicts: 0, progressed: 0, skippedReasons: [], ran: true });

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

type Resolver = Awaited<ReturnType<typeof ownerResolver>>;

export async function syncConnection(
  connectionId: string, trigger: "manual" | "cron" | "initial", actorUserId?: string, deadline?: number,
): Promise<SyncSummary> {
  const [conn] = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connectionId));
  if (!conn) throw new Error("Connection not found");
  const [ws] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, conn.workspaceId));
  const settings = readSettings(ws.settings);
  const maps = await db.select().from(schema.worksheetMapping)
    .where(and(eq(schema.worksheetMapping.connectionId, conn.id), eq(schema.worksheetMapping.enabled, true)));
  const confirmed = maps.filter((m) => m.confirmedAt);
  // Repair id-style names ("Worksheet 123") with the tab's real title. Best effort: a failure here never affects the sync.
  if (maps.some((m) => isPlaceholderTitle(m.sheetTitle))) {
    try {
      const live = await fetchTabList(conn.spreadsheetId);
      for (const m of maps) {
        const t = live.find((x) => x.gid === m.sheetGid);
        if (t && isPlaceholderTitle(m.sheetTitle) && t.title !== m.sheetTitle) {
          await db.update(schema.worksheetMapping).set({ sheetTitle: t.title }).where(eq(schema.worksheetMapping.id, m.id));
          m.sheetTitle = t.title;
        }
      }
    } catch { /* keep the old name */ }
  }
  // Waiting for confirmation is a normal state, not a failure: do nothing and leave health untouched.
  if (!confirmed.length) return { ...emptySummary(), ran: false };

  // Reap jobs killed mid-run, then claim the connection atomically. The advisory lock makes "check, then insert" safe against a
  // second sync (cron, GitHub schedule, manual button) starting at the same instant.
  const job = await dbTx.transaction(async (tx) => {
    const [{ ok }] = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${"sheetsync:" + conn.id})) as ok`)).rows as { ok: boolean }[];
    if (!ok) return null;
    await tx.update(schema.syncJob).set({ status: "failed", finishedAt: new Date(), error: "Interrupted (timed out). Retried automatically." })
      .where(and(eq(schema.syncJob.connectionId, conn.id), eq(schema.syncJob.status, "running"), sql`${schema.syncJob.startedAt} < now() - interval '10 minutes'`));
    const [live] = await tx.select({ id: schema.syncJob.id }).from(schema.syncJob)
      .where(and(eq(schema.syncJob.connectionId, conn.id), eq(schema.syncJob.status, "running"))).limit(1);
    if (live) return null;
    const [j] = await tx.insert(schema.syncJob).values({ connectionId: conn.id, trigger, status: "running" }).returning();
    return j;
  });
  if (!job) return { ...emptySummary(), ran: false };
  const total = emptySummary();
  const errors: string[] = [];
  let budgetHit = false;

  try {
    const resolve = await ownerResolver(conn.workspaceId);
    for (const m of confirmed) {
      try {
        const table = await fetchWorksheetCsv(conn.spreadsheetId, m.sheetGid, deadline);
        const map = { ...DEFAULT_COLUMN_MAP, ...(m.columnMap as Partial<ColumnMap>) } as ColumnMap;
        const parsed = parseWorksheet(table, map, ws.timezone, fromZonedTime, Math.max(0, m.headerRow - 1));
        if (parsed.missingColumns.length) { errors.push(`“${m.sheetTitle}”: columns not found: ${parsed.missingColumns.join(", ")}`); continue; }
        const skippedN = parsed.skipped.reduce((a, s) => a + s.count, 0);
        total.seen += parsed.rows.length + skippedN;
        total.skipped += skippedN;
        total.skippedReasons.push(...parsed.skipped.map((s) => `${s.count} × ${s.reason}`));
        // ingest adds to `total` as each chunk commits, so counts stay true even if a later chunk fails.
        await ingest(conn, ws, settings, m.sheetGid, parsed.rows, resolve, total, deadline);
      } catch (e) {
        if (e instanceof BudgetError) { budgetHit = true; break; }
        errors.push(`“${m.sheetTitle}”: ${e instanceof Error ? e.message : "failed"}`);
        if (!(e instanceof PermanentSyncError)) console.error("sheet sync", e);
      }
    }
    const failed = errors.length > 0;
    total.partial = budgetHit;
    const status = !failed ? (budgetHit ? "partial" : "success") : confirmed.length > errors.length ? "partial" : "failed";
    if (budgetHit) errors.push("Not finished in the time allowed; the next run continues from where it stopped.");
    await db.update(schema.syncJob).set({
      status, finishedAt: new Date(), rowsSeen: total.seen, rowsCreated: total.created, rowsUpdated: total.updated, rowsSkipped: total.skipped,
      error: failed || budgetHit ? errors.join("\n").slice(0, 1500) : null,
    }).where(eq(schema.syncJob.id, job.id));
    await db.update(schema.spreadsheetConnection).set(
      failed ? { healthy: false, lastError: errors.join("\n").slice(0, 1500) }
        : budgetHit ? {} : { healthy: true, lastError: null, lastSuccessfulSyncAt: new Date() },
    ).where(eq(schema.spreadsheetConnection.id, conn.id));
    if (trigger !== "cron" && actorUserId) {
      await db.insert(schema.auditLog).values({ workspaceId: conn.workspaceId, actorId: actorUserId, action: "sheet.sync", entity: "spreadsheet_connection", entityId: conn.id, data: { ...total } });
    }
    return total;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    await db.update(schema.syncJob).set({ status: "failed", finishedAt: new Date(), error: msg.slice(0, 1500), rowsCreated: total.created, rowsUpdated: total.updated }).where(eq(schema.syncJob.id, job.id));
    await db.update(schema.spreadsheetConnection).set({ healthy: false, lastError: msg.slice(0, 1500) }).where(eq(schema.spreadsheetConnection.id, conn.id));
    throw e;
  }
}

const OPEN_STEPS = new Set(["contact_started", "h24", "h48", "final"]);
const STEP_LABEL: Record<string, string> = { contact_started: "Contact started", h24: "24H follow-up", h48: "48H follow-up", final: "Final follow-up", completed: "Completed" };

/**
 * Brings what the team already recorded in the sheet into the CRM: owner (for leads still unassigned), status, follow-up stage,
 * card milestones and notes. Rules: a CRM edit always wins (see mayApplyProgress); milestones only ever get added; notes are added
 * to the timeline, never overwritten; no notification is sent, so a backfill cannot flood anyone.
 */
export async function applyProgress(tx: Tx, conn: typeof schema.spreadsheetConnection.$inferSelect, leadId: string, r: ParsedRow, resolve: Resolver, now: Date, out: { assigned: number; progressed: number; conflicts?: number }, opts: { forced?: boolean } = {}) {
  const [lead] = await tx.select().from(L).where(eq(L.id, leadId)).for("update");
  if (!lead) return;
  const set: Partial<typeof L.$inferInsert> = {};
  const said: string[] = [];
  const cust = (lead.custom ?? {}) as Record<string, unknown> & { progressBase?: ProgressBase; sheetProgress?: Seen };

  let ownerId = lead.ownerId;
  if (!ownerId) {
    const { memberId } = resolve(r.ownerAlias);
    if (memberId) {
      ownerId = memberId; set.ownerId = memberId; out.assigned++;
      await tx.insert(schema.leadActivity).values({
        leadId: lead.id, workspaceId: conn.workspaceId, type: "assigned", actorId: null,
        summary: `Assigned from the sheet owner column (“${r.ownerAlias}”)`, idempotencyKey: `assign:sheet:${lead.id}`,
      }).onConflictDoNothing();
    }
  }

  const plan = planProgress({ status: r.sheetStatus, stage: r.progress.stage, card: r.progress.card, salesQualified: r.progress.salesQualified, completedMeeting: r.progress.completedMeeting, onboarded: r.progress.onboarded });
  // "forced" is a person choosing the sheet's value for a difference: treat the lead as still matching, so the sheet's state is applied.
  const base = opts.forced ? stateOf(lead) : cust.progressBase;
  const sheetHasState = !!(plan.status || plan.step || plan.closeAs);
  // What the sheet's two cells said when the CRM last matched them. The sheet's progress is applied only when those cells changed (or on first
  // sight), never because some other column of the row changed: otherwise an unrelated edit would undo a CRM status the sheet has no wording for.
  const seen: Seen = { status: r.sheetStatus ?? "", stage: r.progress.stage ?? "" };
  const t0 = cust.sheetProgress;
  const sheetMoved = !!t0 && (clean(seen.status) !== clean(t0.status) || clean(seen.stage) !== clean(t0.stage));
  const canApply = sheetHasState && mayApplyProgress(lead, base) && (!t0 || sheetMoved || !!opts.forced);
  let stepSet: string | null = null;
  if (canApply) {
    if (plan.closeAs) {
      if (!lead.closedAt || lead.outcome !== plan.closeAs) {
        Object.assign(set, { outcome: plan.closeAs, status: plan.closeAs, closedAt: lead.closedAt ?? now, closureReason: "Marked in the sheet", followUpStep: "completed" as const, nextFollowUpAt: null, convertedAt: plan.closeAs === "converted" ? now : null });
        await tx.update(schema.followUpTask).set({ status: "cancelled", updatedAt: now, notes: `Closed from the sheet: ${plan.closeAs}` })
          .where(and(eq(schema.followUpTask.leadId, lead.id), eq(schema.followUpTask.status, "pending")));
        said.push(`closed as ${plan.closeAs.replace("_", " ")}`);
      }
    } else {
      if (lead.closedAt) {
        Object.assign(set, { closedAt: null, outcome: null, closureReason: null, convertedAt: null }); said.push("reopened");
        // A reopened lead must not stay at "completed": the sheet's stage wins, otherwise it starts again at the first step.
        if (!plan.step && lead.followUpStep === "completed") { set.followUpStep = "contact_started"; stepSet = "contact_started"; }
      }
      if (plan.status && plan.status !== lead.status) { set.status = plan.status; said.push(`status ${plan.status.replace("_", " ")}`); }
      if (plan.step && plan.step !== lead.followUpStep) { set.followUpStep = plan.step; said.push(STEP_LABEL[plan.step]); }
      if (plan.step && OPEN_STEPS.has(plan.step)) stepSet = plan.step; // also when it equals the default stage: the lead still needs its task
    }
  }
  for (const m of plan.milestones) if (!lead[m]) { set[m] = now; said.push(m.replace(/At$/, "").replace(/([A-Z])/g, " $1").toLowerCase()); }

  // A follow-up stage with an owner needs an open task, or it never shows in the follow-up lists. Due later today, not overdue.
  const finalStep = (set.followUpStep as string | undefined) ?? lead.followUpStep;
  const closedNow = set.closedAt !== undefined ? set.closedAt !== null : !!lead.closedAt;
  if (stepSet && ownerId && !closedNow && OPEN_STEPS.has(finalStep)) {
    const [open] = await tx.select({ id: schema.followUpTask.id }).from(schema.followUpTask)
      .where(and(eq(schema.followUpTask.leadId, lead.id), eq(schema.followUpTask.status, "pending"))).limit(1);
    if (!open) {
      const due = new Date(now.getTime() + 2 * 3600e3);
      const [t] = await tx.insert(schema.followUpTask).values({
        workspaceId: conn.workspaceId, leadId: lead.id, step: finalStep as "contact_started" | "h24" | "h48" | "final", dueAt: due, ownerId,
        priority: "normal", createdBy: "sheet-sync", dedupeKey: `${lead.id}:${finalStep}:sheet`,
      }).onConflictDoNothing().returning({ id: schema.followUpTask.id });
      if (t) set.nextFollowUpAt = due;
    }
  }

  const sourceState = { status: (set.status as string | undefined) ?? lead.status, step: (set.followUpStep as string | undefined) ?? lead.followUpStep, closed: closedNow };
  const applied = said.length > 0;
  const flags = { salesQualified: plan.flags.salesQualified, completedMeeting: plan.flags.completedMeeting, onboarded: plan.flags.onboarded, referralCode: r.progress.referralCode, cardStatus: r.progress.card };

  // The recorded cells move only when the CRM followed the sheet (or on first sight) or the CRM already matches them, so a change made on
  // both sides stays visible and becomes a difference for a person to settle, never a silent overwrite.
  const nextT0 = canApply || !t0 || (sheetMoved && mayApplyProgress(lead, base)) ? seen : t0;
  if (base && t0 && sheetMoved && !canApply && !opts.forced) {
    const crmText = `${lead.status.replace("_", " ")} | ${STEP_LABEL[lead.followUpStep] ?? lead.followUpStep}`;
    const open = await tx.select().from(schema.syncConflict).where(and(eq(schema.syncConflict.leadId, lead.id), eq(schema.syncConflict.field, "progress"), isNull(schema.syncConflict.resolvedAt)));
    if (!open.some((o) => o.sheetValue === sheetText(seen) && o.crmValue === crmText)) {
      if (open.length) await tx.update(schema.syncConflict).set({ resolvedAt: now, resolution: "superseded by a newer difference" }).where(inArray(schema.syncConflict.id, open.map((o) => o.id)));
      await tx.insert(schema.syncConflict).values({ connectionId: conn.id, leadId: lead.id, field: "progress", sheetValue: sheetText(seen), crmValue: crmText });
      if (out.conflicts !== undefined) out.conflicts++;
    }
  }
  // The baseline records what the sheet last gave the CRM. It moves only when the CRM still matched it, so a CRM edit is never overwritten.
  const newCustom = { ...cust, ...(opts.forced ? {} : { sheetFlags: flags }), sheetProgress: nextT0, ...(canApply ? { progressBase: sourceState } : {}) };
  const changed = Object.keys(set).length > 0;
  if (changed || JSON.stringify(newCustom) !== JSON.stringify(cust)) {
    await tx.update(L).set({ ...set, custom: newCustom, updatedAt: changed ? now : lead.updatedAt, updatedBy: changed ? "sheet-sync" : lead.updatedBy, version: changed ? lead.version + 1 : lead.version }).where(eq(L.id, lead.id));
  }
  if (applied) {
    out.progressed++;
    await tx.insert(schema.leadActivity).values({
      leadId: lead.id, workspaceId: conn.workspaceId, type: "synced", actorId: null, summary: `Progress from the sheet: ${said.join(", ")}`,
      data: { status: sourceState.status, step: sourceState.step, closed: sourceState.closed },
      idempotencyKey: `progress:${lead.id}:${hashRow(r)}`,
    }).onConflictDoNothing();
  }
  const note = opts.forced ? null : r.progress.notes?.trim();
  if (note) {
    const hash = createHash("sha1").update(note).digest("hex").slice(0, 16);
    // A cell the CRM itself wrote (a CRM note pushed to a two-way sheet) is already in the timeline: never import it a second time.
    const ours = ((cust as { crmNoteCells?: string[] }).crmNoteCells ?? []).includes(hash);
    if (!ours) {
      await tx.insert(schema.leadActivity).values({
        leadId: lead.id, workspaceId: conn.workspaceId, type: "note", actorId: null, summary: `Note from the sheet: ${note}`,
        data: { source: "google_sheets", text: note, sheetTab: conn.title ?? null },
        idempotencyKey: `sheetnote:${hash}`,
      }).onConflictDoNothing();
    }
  }
}

async function ingest(
  conn: typeof schema.spreadsheetConnection.$inferSelect, ws: typeof schema.workspace.$inferSelect,
  settings: ReturnType<typeof readSettings>, gid: string, rows: ParsedRow[], resolve: Resolver, out: SyncSummary, deadline?: number,
) {
  const now = new Date();

  for (let i = 0; i < rows.length; i += CHUNK) {
    if (deadline && Date.now() > deadline) throw new BudgetError("Out of time for this run; the rest is imported on the next run.");
    const chunk = rows.slice(i, i + CHUNK);
    const ids = chunk.map((r) => r.externalId);
    const existing = await db.select({ id: L.id, externalId: L.externalId, hash: L.sourceRowHash, name: L.name, phoneRaw: L.phoneRaw, email: L.email, campaign: L.campaign, source: L.source, custom: L.custom })
      .from(L).where(and(eq(L.connectionId, conn.id), eq(L.sheetGid, gid), inArray(L.externalId, ids)));
    const have = new Map(existing.map((e) => [e.externalId!, e]));

    const fresh = chunk.filter((r) => !have.has(r.externalId));
    const changed = chunk.filter((r) => { const e = have.get(r.externalId); return e && e.hash !== hashRow(r); });

    // Possible duplicates: same phone or email already known in this workspace, or earlier in this same batch.
    const phones = [...new Set(fresh.map((r) => r.phoneNorm).filter((x): x is string => !!x))];
    const emails = [...new Set(fresh.map((r) => r.emailNorm).filter((x): x is string => !!x))];
    const dupes = phones.length || emails.length
      ? await db.select({ id: L.id, phone: L.phoneNorm, email: L.emailNorm }).from(L).where(and(
          eq(L.workspaceId, conn.workspaceId), isNull(L.mergedIntoId),
          sql`(${phones.length ? inArray(L.phoneNorm, phones) : sql`false`} or ${emails.length ? inArray(L.emailNorm, emails) : sql`false`})`))
      : [];

    const planned = fresh.map((r) => ({ r, id: randomUUID() }));
    const seenInBatch: { id: string; phone: string | null; email: string | null }[] = [];
    const plan = planned.map(({ r, id }) => {
      const pool = [...dupes, ...seenInBatch];
      const dup = pool.find((d) => (r.phoneNorm && d.phone === r.phoneNorm) || (r.emailNorm && d.email === r.emailNorm))?.id ?? null;
      seenInBatch.push({ id, phone: r.phoneNorm, email: r.emailNorm });
      const { memberId } = resolve(r.ownerAlias);
      // History must not flood people: only recent, untouched leads get an immediate contact task.
      const age = r.acquiredAt ? now.getTime() - r.acquiredAt.getTime() : null;
      const recent = age !== null && age <= RECENT_LEAD_MS && age >= -86_400_000;
      const untouched = !r.sheetStatus;
      const due = memberId && recent && untouched ? dueFor("contact_started", now, now, settings) : null;
      return { r, id, memberId, due, dup };
    });

    await dbTx.transaction(async (tx) => {
      const chunkOut = { created: 0, updated: 0, assigned: 0, possibleDuplicates: 0, conflicts: 0, progressed: 0 };
      if (plan.length) {
        const inserted = await tx.insert(L).values(plan.map((p) => ({
          id: p.id, workspaceId: conn.workspaceId, name: p.r.name, phoneRaw: p.r.phoneRaw, phoneNorm: p.r.phoneNorm,
          email: p.r.email, emailNorm: p.r.emailNorm, source: p.r.source, campaign: p.r.campaign,
          ownerId: p.memberId, followUpStep: "contact_started" as const, nextFollowUpAt: p.due,
          acquiredAt: p.r.acquiredAt ?? now, importedAt: now, connectionId: conn.id, sheetGid: gid, externalId: p.r.externalId,
          sourceRowHash: hashRow(p.r), sourceRaw: p.r.raw, sourceUrl: `https://docs.google.com/spreadsheets/d/${conn.spreadsheetId}/edit?gid=${gid}`,
          custom: {
            sheetStatus: p.r.sheetStatus, ownerNameInSheet: p.r.ownerAlias, sheetBase: baseOf(p.r),
            ...(p.r.acquiredAt ? {} : { acquiredDateMissing: true }), ...(p.dup ? { possibleDuplicateOf: p.dup } : {}),
          },
          lastSyncedAt: now, createdBy: "sheet-sync", updatedBy: "sheet-sync",
        }))).onConflictDoNothing().returning({ id: L.id });
        const made = new Set(inserted.map((x) => x.id));
        for (const p of plan) {
          if (!made.has(p.id)) continue; // a concurrent sync inserted it first
          chunkOut.created++;
          await tx.insert(schema.leadActivity).values({
            leadId: p.id, workspaceId: conn.workspaceId, type: "imported", actorId: null,
            summary: `Imported from “${conn.title ?? "Google Sheet"}”`, data: { externalId: p.r.externalId }, idempotencyKey: `import:${p.r.externalId}`,
          }).onConflictDoNothing();
          if (p.dup) {
            chunkOut.possibleDuplicates++;
            await tx.insert(schema.leadActivity).values({
              leadId: p.id, workspaceId: conn.workspaceId, type: "note", actorId: null,
              summary: "Possible duplicate: the same phone or email already exists on another lead. Nothing was merged.", data: { otherLeadId: p.dup }, idempotencyKey: `dup:${p.r.externalId}`,
            }).onConflictDoNothing();
          }
          if (p.memberId) {
            chunkOut.assigned++;
            await tx.insert(schema.leadActivity).values({
              leadId: p.id, workspaceId: conn.workspaceId, type: "assigned", actorId: null,
              summary: `Assigned from the sheet owner column (“${p.r.ownerAlias}”)${p.due ? "" : ". Older or already-worked lead, so no contact task was created"}`,
              idempotencyKey: `assign:import:${p.r.externalId}`,
            }).onConflictDoNothing();
          }
          if (p.memberId && p.due) {
            await tx.insert(schema.followUpTask).values({
              workspaceId: conn.workspaceId, leadId: p.id, step: "contact_started", dueAt: p.due, ownerId: p.memberId,
              priority: "normal", createdBy: "sheet-sync", dedupeKey: `${p.id}:contact_started:0`,
            }).onConflictDoNothing();
            await notify(tx, { workspaceId: conn.workspaceId, memberId: p.memberId, kind: "assignment", title: `New lead: ${p.r.name}`, leadId: p.id, dedupeKey: `assign:import:${p.id}` });
          } else if (!p.memberId && p.r.ownerAlias && resolve(p.r.ownerAlias).unmapped) {
            const [open] = await tx.select({ id: schema.syncConflict.id }).from(schema.syncConflict).where(and(
              eq(schema.syncConflict.connectionId, conn.id), eq(schema.syncConflict.field, "unmapped_owner"),
              eq(schema.syncConflict.sheetValue, p.r.ownerAlias), isNull(schema.syncConflict.resolvedAt))).limit(1);
            if (!open) await tx.insert(schema.syncConflict).values({ connectionId: conn.id, leadId: p.id, field: "unmapped_owner", sheetValue: p.r.ownerAlias, crmValue: null });
          }
          await applyProgress(tx, conn, p.id, p.r, resolve, now, chunkOut);
        }
      }

      // The sheet may change a field only while the CRM still holds the value the sheet last wrote.
      // If someone edited it in the CRM, the CRM value wins and the difference is recorded as a conflict.
      for (const r of changed) {
        const [e] = await tx.select().from(L).where(eq(L.id, have.get(r.externalId)!.id)).for("update"); // fresh and locked: a CRM edit cannot slip in between
        if (!e) continue;
        const cust = (e.custom ?? {}) as Record<string, unknown> & { sheetBase?: Base };
        const oldBase = cust.sheetBase;
        const next = baseOf(r);
        const set: Partial<typeof L.$inferInsert> = {};
        const newBase: Base = { ...(oldBase ?? next) };
        const applied: string[] = [];
        for (const k of SOURCE_FIELDS) {
          const crm = (e[k] as string | null) ?? null;
          if (crm === next[k]) { newBase[k] = next[k]; continue; }
          const was = oldBase ? (oldBase[k] ?? null) : undefined;
          if (oldBase && was === next[k]) continue; // the sheet did not change this field; the CRM value is the team's, leave it alone
          if (oldBase && crm === was) {
            (set as Record<string, unknown>)[k] = next[k];
            if (k === "phoneRaw") set.phoneNorm = r.phoneNorm;
            if (k === "email") set.emailNorm = r.emailNorm;
            newBase[k] = next[k]; applied.push(k);
          } else {
            // Only the newest difference per lead and field stays open; older ones are superseded.
            const open = await tx.select().from(schema.syncConflict).where(and(
              eq(schema.syncConflict.leadId, e.id), eq(schema.syncConflict.field, k), isNull(schema.syncConflict.resolvedAt)));
            if (open.some((o) => o.sheetValue === (next[k] ?? "") && o.crmValue === crm)) continue;
            if (open.length) {
              await tx.update(schema.syncConflict).set({ resolvedAt: now, resolution: "superseded by a newer difference" })
                .where(inArray(schema.syncConflict.id, open.map((o) => o.id)));
            }
            await tx.insert(schema.syncConflict).values({ connectionId: conn.id, leadId: e.id, field: k, sheetValue: next[k] ?? "", crmValue: crm });
            chunkOut.conflicts++;
          }
        }
        await tx.update(L).set({
          ...set, sourceRowHash: hashRow(r), sourceRaw: r.raw, lastSyncedAt: now, updatedAt: now, updatedBy: "sheet-sync", version: e.version + (applied.length ? 1 : 0),
          custom: { ...cust, sheetStatus: r.sheetStatus, ownerNameInSheet: r.ownerAlias, sheetBase: newBase },
        }).where(eq(L.id, e.id));
        if (applied.length) {
          await tx.insert(schema.leadActivity).values({
            leadId: e.id, workspaceId: conn.workspaceId, type: "synced", actorId: null, summary: `Updated from the sheet: ${applied.join(", ")}`,
            idempotencyKey: `sync:${e.id}:${hashRow(r)}`,
          }).onConflictDoNothing();
          chunkOut.updated++;
        }
        await applyProgress(tx, conn, e.id, r, resolve, now, chunkOut);
      }
      // Counted only after the chunk commits (the callback returning without throwing).
      out.created += chunkOut.created; out.updated += chunkOut.updated; out.assigned += chunkOut.assigned;
      out.possibleDuplicates += chunkOut.possibleDuplicates; out.conflicts += chunkOut.conflicts; out.progressed += chunkOut.progressed;
    });
  }
}

/** Runs every connection with a confirmed mapping inside a time budget. One failing sheet never blocks the others. */
export async function syncAllConnections(budgetMs = 35_000): Promise<{ connections: number; created: number; failed: number; skipped: number }> {
  const deadline = Date.now() + budgetMs;
  const conns = await db.select({ id: schema.spreadsheetConnection.id }).from(schema.spreadsheetConnection)
    .orderBy(sql`${schema.spreadsheetConnection.lastSuccessfulSyncAt} asc nulls first`); // least recently synced first, so none starves
  const r = { connections: conns.length, created: 0, failed: 0, skipped: 0 };
  for (const c of conns) {
    if (Date.now() > deadline) { r.skipped++; continue; }
    try {
      const s = await syncConnection(c.id, "cron", undefined, deadline);
      if (!s.ran) r.skipped++; else r.created += s.created;
    } catch { r.failed++; }
  }
  return r;
}
