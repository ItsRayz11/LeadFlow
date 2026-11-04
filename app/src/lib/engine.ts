import "server-only";
import { and, count, eq, isNull } from "drizzle-orm";
import { schema } from "@/db";
import { dbTx, type Tx } from "@/db/tx";
import type { Ctx } from "@/lib/session";
import { notify } from "@/lib/notify";
import {
  dueFor, nextStep, readSettings, retryAt, type Settings, type Step,
} from "@/lib/schedule";

const L = schema.lead;
const T = schema.followUpTask;
const A = schema.leadActivity;

export class EngineError extends Error {}

export type Outcome = (typeof schema.interactionOutcomeEnum.enumValues)[number];
export type Channel = (typeof schema.channelEnum.enumValues)[number];
export type LeadOutcome = (typeof schema.outcomeEnum.enumValues)[number];
type LeadRow = typeof L.$inferSelect;
type TaskRow = typeof T.$inferSelect;
type LeadUpdate = Partial<typeof L.$inferInsert>;

export const OUTCOME_LABEL: Record<Outcome, string> = {
  reached: "Spoke to lead", no_answer: "No answer", interested: "Interested",
  callback_requested: "Callback requested", converted: "Converted", not_interested: "Not interested", dropped: "Dropped",
};
const CHANNEL_LABEL: Record<Channel, string> = { call: "call", whatsapp: "WhatsApp", email: "email", sms: "SMS", other: "contact" };

/* ---------------- helpers ---------------- */

async function loadLead(tx: Tx, ctx: Ctx, leadId: string): Promise<LeadRow> {
  const [lead] = await tx.select().from(L)
    .where(and(eq(L.id, leadId), eq(L.workspaceId, ctx.workspaceId), isNull(L.mergedIntoId)))
    .for("update");
  if (!lead) throw new EngineError("Lead not found.");
  if (ctx.role === "viewer") throw new EngineError("Your role is read-only.");
  if (ctx.role === "bd" && lead.ownerId !== ctx.memberId) throw new EngineError("This lead belongs to someone else.");
  return lead;
}

function requireManager(ctx: Ctx) {
  if (ctx.role !== "admin" && ctx.role !== "manager") throw new EngineError("Only managers and admins can do this.");
}

async function settingsOf(tx: Tx, ctx: Ctx): Promise<Settings> {
  const [w] = await tx.select({ s: schema.workspace.settings }).from(schema.workspace).where(eq(schema.workspace.id, ctx.workspaceId));
  return readSettings(w?.s);
}

async function seen(tx: Tx, leadId: string, key: string) {
  const [e] = await tx.select({ id: A.id }).from(A).where(and(eq(A.leadId, leadId), eq(A.idempotencyKey, key))).limit(1);
  return !!e;
}

async function pendingTask(tx: Tx, leadId: string): Promise<TaskRow | undefined> {
  const [t] = await tx.select().from(T).where(and(eq(T.leadId, leadId), eq(T.status, "pending"))).for("update");
  return t;
}

async function log(tx: Tx, ctx: Ctx, lead: LeadRow, a: {
  type: (typeof schema.activityTypeEnum.enumValues)[number]; summary: string; key?: string;
  channel?: Channel | null; outcome?: Outcome | null; data?: Record<string, unknown>;
}) {
  await tx.insert(A).values({
    leadId: lead.id, workspaceId: ctx.workspaceId, type: a.type, actorId: ctx.userId, summary: a.summary,
    channel: a.channel ?? null, outcome: a.outcome ?? null, data: a.data ?? {}, idempotencyKey: a.key ?? null,
  }).onConflictDoNothing();
}

/** One task per lead+step+attempt number. The partial unique index also guarantees a single open task per lead. */
async function createTask(tx: Tx, ctx: Ctx, lead: LeadRow, step: Step, dueAt: Date, extra: { anchor?: Date | null; priority?: "low" | "normal" | "high" | "urgent"; ownerId?: string | null } = {}) {
  const [{ n }] = await tx.select({ n: count() }).from(T).where(and(eq(T.leadId, lead.id), eq(T.step, step)));
  const [t] = await tx.insert(T).values({
    workspaceId: ctx.workspaceId, leadId: lead.id, step, dueAt,
    ownerId: extra.ownerId === undefined ? lead.ownerId : extra.ownerId,
    priority: extra.priority ?? "normal", anchorAt: extra.anchor ?? null, createdBy: ctx.userId,
    dedupeKey: `${lead.id}:${step}:${n}`,
  }).returning();
  return t;
}

/** Moves the lead on after a task was completed. Returns the lead fields to write. */
async function advance(tx: Tx, ctx: Ctx, lead: LeadRow, task: TaskRow, anchor: Date, now: Date, s: Settings): Promise<LeadUpdate> {
  const next = nextStep(task.step);
  if (!next) return { followUpStep: "completed", nextFollowUpAt: null };
  const due = dueFor(next, anchor, now, s);
  await createTask(tx, ctx, lead, next, due, { anchor });
  return { followUpStep: next, nextFollowUpAt: due };
}

function closeFields(outcome: LeadOutcome, now: Date, reason?: string | null): LeadUpdate {
  const status = outcome === "converted" ? "converted" : outcome === "not_interested" ? "not_interested" : outcome === "no_response" ? "no_response" : "cold";
  return {
    outcome, status, closedAt: now, closureReason: reason || null, followUpStep: "completed", nextFollowUpAt: null,
    convertedAt: outcome === "converted" ? now : null,
  };
}

async function saveLead(tx: Tx, ctx: Ctx, lead: LeadRow, upd: LeadUpdate, now: Date) {
  await tx.update(L).set({ ...upd, updatedAt: now, updatedBy: ctx.userId, version: lead.version + 1 }).where(eq(L.id, lead.id));
}

/* ---------------- record a contact attempt / result ---------------- */

export async function recordOutcome(ctx: Ctx, i: {
  leadId: string; requestId: string; outcome: Outcome; channel: Channel; notes?: string; nextAt?: Date | null;
}) {
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `outcome:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    if (lead.closedAt) throw new EngineError("This lead is closed. Reopen it first.");

    const now = new Date();
    const s = await settingsOf(tx, ctx);
    const task = await pendingTask(tx, lead.id);
    const contacted = i.outcome !== "no_answer";
    const upd: LeadUpdate = { followUpAttempts: lead.followUpAttempts + 1, lastResult: i.outcome };
    if (contacted) {
      upd.lastContactedAt = now;
      if (!lead.firstContactedAt) upd.firstContactedAt = now;
    }
    const anchor = (upd.firstContactedAt as Date | undefined) ?? lead.firstContactedAt ?? now;
    const via = CHANNEL_LABEL[i.channel];
    const notes = i.notes?.trim() || null;
    let summary = `${OUTCOME_LABEL[i.outcome]} (${via})`;
    let type: "contacted" | "no_answer" | "closed" = i.outcome === "no_answer" ? "no_answer" : "contacted";

    const finishTask = async (t: TaskRow) => {
      await tx.update(T).set({
        status: "completed", outcome: i.outcome, channel: i.channel, notes, completedAt: now, completedBy: ctx.userId,
        attempts: t.attempts + 1, updatedAt: now,
      }).where(eq(T.id, t.id));
    };

    switch (i.outcome) {
      case "no_answer": {
        if (!task) { summary += ". No follow-up is scheduled"; break; }
        const attempts = task.attempts + 1;
        if (attempts >= s.maxNoAnswer) {
          // The sequence moves on, but the lead is never closed because of unanswered attempts.
          await finishTask(task);
          Object.assign(upd, await advance(tx, ctx, lead, task, anchor, now, s));
          summary += `. ${attempts} unanswered attempts, moving to the next step`;
        } else {
          const at = retryAt(now, s);
          await tx.update(T).set({ attempts, dueAt: at, channel: i.channel, notes, updatedAt: now }).where(eq(T.id, task.id));
          upd.nextFollowUpAt = at;
          summary += `. Retry scheduled (attempt ${attempts} of ${s.maxNoAnswer})`;
        }
        break;
      }
      case "reached":
      case "interested": {
        if (lead.status === "new" || (i.outcome === "interested" && lead.status !== "proposal_sent")) upd.status = i.outcome === "interested" ? "interested" : "contacted";
        if (task) {
          await finishTask(task);
          Object.assign(upd, await advance(tx, ctx, lead, task, anchor, now, s));
        }
        break;
      }
      case "callback_requested": {
        const at = i.nextAt ?? new Date(now.getTime() + 24 * 3_600_000);
        if (at.getTime() < now.getTime() - 60_000) throw new EngineError("Pick a callback time in the future.");
        if (lead.status === "new") upd.status = "contacted";
        const step: Step = task ? (task.step as Step) : lead.followUpStep === "completed" ? "final" : lead.followUpStep;
        if (task) await finishTask(task);
        await createTask(tx, ctx, lead, step, at, { anchor, priority: "high" });
        upd.followUpStep = step;
        upd.nextFollowUpAt = at;
        summary += ` for ${at.toISOString()}`;
        break;
      }
      case "converted":
      case "not_interested":
      case "dropped": {
        if (task) await finishTask(task);
        Object.assign(upd, closeFields(i.outcome, now, notes));
        type = "closed";
        break;
      }
    }

    await saveLead(tx, ctx, lead, upd, now);
    await log(tx, ctx, lead, { type, summary, key, channel: i.channel, outcome: i.outcome, data: { notes, taskId: task?.id ?? null } });
    return { duplicate: false as const, nextAt: (upd.nextFollowUpAt as Date | null | undefined) ?? lead.nextFollowUpAt };
  });
}

/* ---------------- schedule / reschedule ---------------- */

export async function scheduleNext(ctx: Ctx, i: { leadId: string; requestId: string; at: Date; notes?: string }) {
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `schedule:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    if (lead.closedAt) throw new EngineError("This lead is closed. Reopen it first.");
    const now = new Date();
    if (i.at.getTime() < now.getTime() - 60_000) throw new EngineError("Pick a time in the future.");
    const task = await pendingTask(tx, lead.id);
    const step: Step = task ? (task.step as Step) : lead.followUpStep === "completed" ? "final" : lead.followUpStep;
    if (task) await tx.update(T).set({ status: "rescheduled", notes: i.notes?.trim() || task.notes, updatedAt: now }).where(eq(T.id, task.id));
    await createTask(tx, ctx, lead, step, i.at, { anchor: lead.firstContactedAt, priority: task?.priority ?? "normal" });
    await saveLead(tx, ctx, lead, { followUpStep: step, nextFollowUpAt: i.at }, now);
    await log(tx, ctx, lead, { type: "followup_rescheduled", summary: `Follow-up rescheduled to ${i.at.toISOString()}`, key, data: { from: task?.dueAt ?? null, to: i.at, notes: i.notes ?? null } });
    return { duplicate: false as const };
  });
}

/* ---------------- assignment ---------------- */

export async function assignLead(ctx: Ctx, i: { leadId: string; ownerId: string | null; requestId: string; reason?: string }) {
  requireManager(ctx);
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `assign:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    let ownerName = "nobody";
    if (i.ownerId) {
      const [m] = await tx.select().from(schema.workspaceMember)
        .where(and(eq(schema.workspaceMember.id, i.ownerId), eq(schema.workspaceMember.workspaceId, ctx.workspaceId), eq(schema.workspaceMember.active, true)));
      if (!m) throw new EngineError("That team member is not active in this workspace.");
      if (m.role === "viewer") throw new EngineError("Read-only members cannot own leads.");
      ownerName = m.displayName;
    }
    if (lead.ownerId === i.ownerId) return { duplicate: false as const, unchanged: true as const };
    const now = new Date();
    const s = await settingsOf(tx, ctx);
    const upd: LeadUpdate = { ownerId: i.ownerId };
    let task = await pendingTask(tx, lead.id);
    if (task) {
      await tx.update(T).set({ ownerId: i.ownerId, updatedAt: now }).where(eq(T.id, task.id));
    } else if (i.ownerId && !lead.closedAt && !lead.firstContactedAt) {
      const due = dueFor("contact_started", now, now, s);
      task = await createTask(tx, ctx, lead, "contact_started", due, { ownerId: i.ownerId });
      upd.followUpStep = "contact_started";
      upd.nextFollowUpAt = due;
    }
    await saveLead(tx, ctx, lead, upd, now);
    await log(tx, ctx, lead, {
      type: "assigned", summary: `Assigned to ${ownerName}${i.reason ? `: ${i.reason}` : ""}`, key,
      data: { from: lead.ownerId, to: i.ownerId, reason: i.reason ?? null },
    });
    if (i.ownerId && i.ownerId !== ctx.memberId) {
      await notify(tx, { workspaceId: ctx.workspaceId, memberId: i.ownerId, kind: "assignment", title: `New lead: ${lead.name}`, body: i.reason, leadId: lead.id, taskId: task?.id, dedupeKey: `assign:${lead.id}:${key}` });
    }
    return { duplicate: false as const };
  });
}

/* ---------------- close / reopen ---------------- */

export async function closeLead(ctx: Ctx, i: { leadId: string; outcome: LeadOutcome; reason?: string; requestId: string }) {
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `close:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    if (lead.closedAt) throw new EngineError("This lead is already closed.");
    const now = new Date();
    const task = await pendingTask(tx, lead.id);
    if (task) await tx.update(T).set({ status: "cancelled", updatedAt: now, notes: `Lead closed: ${i.outcome}` }).where(eq(T.id, task.id));
    await saveLead(tx, ctx, lead, closeFields(i.outcome, now, i.reason), now);
    await log(tx, ctx, lead, { type: "closed", summary: `Closed as ${i.outcome.replace("_", " ")}${i.reason ? `: ${i.reason}` : ""}`, key, data: { outcome: i.outcome, reason: i.reason ?? null } });
    return { duplicate: false as const };
  });
}

export async function reopenLead(ctx: Ctx, i: { leadId: string; requestId: string }) {
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `reopen:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    if (!lead.closedAt) throw new EngineError("This lead is not closed.");
    const now = new Date();
    const s = await settingsOf(tx, ctx);
    const upd: LeadUpdate = { outcome: null, closedAt: null, closureReason: null, convertedAt: null, status: lead.firstContactedAt ? "contacted" : "new" };
    if (lead.ownerId && !(await pendingTask(tx, lead.id))) {
      const step: Step = lead.firstContactedAt ? "h24" : "contact_started";
      const due = dueFor(step, lead.firstContactedAt ?? now, now, s);
      await createTask(tx, ctx, lead, step, due, { anchor: lead.firstContactedAt });
      upd.followUpStep = step;
      upd.nextFollowUpAt = due;
    } else {
      upd.followUpStep = lead.firstContactedAt ? "h24" : "contact_started";
    }
    await saveLead(tx, ctx, lead, upd, now);
    await log(tx, ctx, lead, { type: "reopened", summary: "Lead reopened", key });
    return { duplicate: false as const };
  });
}

/* ---------------- edits, notes, milestones ---------------- */

const EDITABLE_STATUS = ["new", "contacted", "interested", "proposal_sent", "cold"] as const;

export async function updateLead(ctx: Ctx, i: {
  leadId: string; requestId: string;
  name?: string; phone?: string | null; email?: string | null; source?: string | null; campaign?: string | null;
  status?: string; priority?: "low" | "normal" | "high" | "urgent";
}) {
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `edit:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    const upd: LeadUpdate = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const set = <K extends keyof LeadUpdate>(k: K, v: LeadUpdate[K], label = String(k)) => {
      if (v !== undefined && v !== (lead as Record<string, unknown>)[k as string]) { upd[k] = v; changes[label] = { from: (lead as Record<string, unknown>)[k as string], to: v }; }
    };
    if (i.name !== undefined) { if (!i.name.trim()) throw new EngineError("Name cannot be empty."); set("name", i.name.trim()); }
    if (i.phone !== undefined) {
      const { normalizePhone } = await import("@/lib/phone");
      const p = i.phone?.trim() || null;
      set("phoneRaw", p, "phone");
      if (p !== lead.phoneRaw) upd.phoneNorm = normalizePhone(p);
    }
    if (i.email !== undefined) { const e = i.email?.trim() || null; set("email", e); if (e !== lead.email) upd.emailNorm = e ? e.toLowerCase() : null; }
    if (i.source !== undefined) set("source", i.source?.trim() || null);
    if (i.campaign !== undefined) set("campaign", i.campaign?.trim() || null);
    if (i.priority) set("priority", i.priority);
    let statusChange = false;
    if (i.status && i.status !== lead.status) {
      if (!(EDITABLE_STATUS as readonly string[]).includes(i.status)) throw new EngineError("Use Close lead to set a final status.");
      if (lead.closedAt) throw new EngineError("Reopen the lead before changing its status.");
      upd.status = i.status as LeadRow["status"];
      changes.status = { from: lead.status, to: i.status };
      statusChange = true;
    }
    if (Object.keys(changes).length === 0) return { duplicate: false as const, unchanged: true as const };
    const now = new Date();
    await saveLead(tx, ctx, lead, upd, now);
    await log(tx, ctx, lead, {
      type: statusChange && Object.keys(changes).length === 1 ? "status_changed" : "edited",
      summary: `Updated ${Object.keys(changes).join(", ")}`, key, data: { changes },
    });
    return { duplicate: false as const };
  });
}

export async function addNote(ctx: Ctx, i: { leadId: string; requestId: string; text: string }) {
  const text = i.text.trim();
  if (!text) throw new EngineError("Write a note first.");
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `note:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    await log(tx, ctx, lead, { type: "note", summary: text.slice(0, 2000), key });
    return { duplicate: false as const };
  });
}

export const MILESTONES = ["appDownloadedAt", "referralSharedAt", "cardPurchasedAt", "spendingStartedAt"] as const;
export type Milestone = (typeof MILESTONES)[number];
const MS_LABEL: Record<Milestone, string> = {
  appDownloadedAt: "App downloaded", referralSharedAt: "Referral code shared", cardPurchasedAt: "Card purchased", spendingStartedAt: "Spending started",
};

export async function setMilestone(ctx: Ctx, i: { leadId: string; requestId: string; milestone: Milestone; on: boolean }) {
  return dbTx.transaction(async (tx) => {
    const lead = await loadLead(tx, ctx, i.leadId);
    const key = `ms:${i.requestId}`;
    if (await seen(tx, lead.id, key)) return { duplicate: true as const };
    const now = new Date();
    if (Boolean(lead[i.milestone]) === i.on) return { duplicate: false as const, unchanged: true as const };
    await saveLead(tx, ctx, lead, { [i.milestone]: i.on ? now : null } as LeadUpdate, now);
    await log(tx, ctx, lead, { type: "milestone", summary: `${MS_LABEL[i.milestone]} ${i.on ? "recorded" : "cleared"}`, key });
    return { duplicate: false as const };
  });
}

/* ---------------- bulk ---------------- */

export async function bulkAssign(ctx: Ctx, ids: string[], ownerId: string | null, requestId: string, reason?: string) {
  requireManager(ctx);
  const results = { done: 0, failed: [] as string[] };
  for (const id of ids.slice(0, 200)) {
    try { await assignLead(ctx, { leadId: id, ownerId, requestId: `${requestId}:${id}`, reason }); results.done++; }
    catch (e) { results.failed.push(`${id}: ${(e as Error).message}`); }
  }
  return results;
}

export async function bulkReschedule(ctx: Ctx, ids: string[], hours: number, requestId: string) {
  const results = { done: 0, failed: [] as string[] };
  const at = new Date(Date.now() + hours * 3_600_000);
  for (const id of ids.slice(0, 200)) {
    try { await scheduleNext(ctx, { leadId: id, at, requestId: `${requestId}:${id}` }); results.done++; }
    catch (e) { results.failed.push(`${id}: ${(e as Error).message}`); }
  }
  return results;
}
