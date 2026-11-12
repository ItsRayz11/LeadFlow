"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { requireCtx } from "@/lib/session";
import { pushLeadNow } from "@/lib/sheetwrite";
import {
  EngineError, addNote, assignLead, bulkAssign, bulkReschedule, closeLead, completeFollowUp, recordOutcome, reopenLead,
  scheduleNext, setMilestone, updateLead,
} from "@/lib/engine";
import { dateAtMorning, dayKey } from "@/lib/schedule";
import { schema } from "@/db";

export type R = { ok?: boolean; error?: string; message?: string; link?: string } | undefined;

const uuid = z.string().uuid();
const req = z.string().min(8).max(80);
const isoDate = z.string().datetime().optional().or(z.literal("").transform(() => undefined));
const fail = (e: unknown): R => {
  if (e instanceof EngineError) return { error: e.message };
  console.error(e);
  return { error: "Something went wrong. Nothing was changed. Try again." };
};
const done = (message: string): R => {
  revalidatePath("/", "layout");
  return { ok: true, message };
};
const obj = (fd: FormData) => Object.fromEntries(fd) as Record<string, string>;

export async function logOutcomeAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({
    leadId: uuid, requestId: req, notes: z.string().max(2000).optional(), nextAt: isoDate,
    outcome: z.enum(schema.interactionOutcomeEnum.enumValues), channel: z.enum(schema.channelEnum.enumValues),
  }).safeParse(obj(fd));
  if (!p.success) return { error: "Choose a channel and a result." };
  try {
    const ctx = await requireCtx();
    const r = await recordOutcome(ctx, { ...p.data, nextAt: p.data.nextAt ? new Date(p.data.nextAt) : null });
    if (!r.duplicate) after(() => pushLeadNow(p.data.leadId)); // the lead's stage may have moved: tell a two-way sheet
    return done(r.duplicate ? "Already saved." : "Saved.");
  } catch (e) { return fail(e); }
}

export async function scheduleAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ leadId: uuid, requestId: req, at: z.string().datetime(), notes: z.string().max(1000).optional() }).safeParse(obj(fd));
  if (!p.success) return { error: "Pick a date and time." };
  try {
    const ctx = await requireCtx();
    await scheduleNext(ctx, { ...p.data, at: new Date(p.data.at) });
    return done("Follow-up scheduled.");
  } catch (e) { return fail(e); }
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("").transform(() => undefined));

/** A plain calendar date picked by a person, read in the workspace time zone. Today means "an hour from now" so it is never already past. */
function pickedDate(date: string, tz: string): Date | null {
  const at = dateAtMorning(date, tz);
  if (!at) return null;
  const now = new Date();
  if (at.getTime() >= now.getTime()) return at;
  return dayKey(at, tz) === dayKey(now, tz) ? new Date(now.getTime() + 3_600_000) : null;
}

/** "Mark Follow-up Done": completes the open follow-up and schedules the next one automatically unless a date is given. */
export async function completeFollowUpAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ leadId: uuid, requestId: req, notes: z.string().max(2000).optional(), nextDate: ymd }).safeParse(obj(fd));
  if (!p.success) return { error: "Check the date and try again." };
  try {
    const ctx = await requireCtx();
    let nextAt: Date | null = null;
    if (p.data.nextDate) { nextAt = pickedDate(p.data.nextDate, ctx.tz); if (!nextAt) return { error: "Pick today or a later date." }; }
    const r = await completeFollowUp(ctx, { leadId: p.data.leadId, requestId: p.data.requestId, notes: p.data.notes, nextAt });
    if (!r.duplicate) after(() => pushLeadNow(p.data.leadId));
    return done(r.duplicate ? "Already saved." : "Follow-up done. The next one is scheduled.");
  } catch (e) { return fail(e); }
}

/** Manual override of the next follow-up date. The chosen date is marked manual, so automation never moves it. */
export async function setFollowUpDateAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ leadId: uuid, requestId: req, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(obj(fd));
  if (!p.success) return { error: "Pick a date." };
  try {
    const ctx = await requireCtx();
    const at = pickedDate(p.data.date, ctx.tz);
    if (!at) return { error: "Pick today or a later date." };
    await scheduleNext(ctx, { leadId: p.data.leadId, requestId: p.data.requestId, at });
    return done("Next follow-up date saved.");
  } catch (e) { return fail(e); }
}

export async function assignAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ leadId: uuid, requestId: req, ownerId: z.string().uuid().or(z.literal("")), reason: z.string().max(300).optional() }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid assignment." };
  try {
    const ctx = await requireCtx();
    const r = await assignLead(ctx, { leadId: p.data.leadId, ownerId: p.data.ownerId || null, requestId: p.data.requestId, reason: p.data.reason });
    return done("unchanged" in r && r.unchanged ? "Already assigned to them." : "Assigned.");
  } catch (e) { return fail(e); }
}

export async function closeAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ leadId: uuid, requestId: req, outcome: z.enum(schema.outcomeEnum.enumValues), reason: z.string().max(500).optional() }).safeParse(obj(fd));
  if (!p.success) return { error: "Choose an outcome." };
  try {
    const ctx = await requireCtx();
    await closeLead(ctx, p.data);
    after(() => pushLeadNow(p.data.leadId));
    return done("Lead closed.");
  } catch (e) { return fail(e); }
}

export async function reopenAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ leadId: uuid, requestId: req }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const ctx = await requireCtx();
    await reopenLead(ctx, p.data);
    after(() => pushLeadNow(p.data.leadId));
    return done("Lead reopened.");
  } catch (e) { return fail(e); }
}

export async function updateLeadAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({
    leadId: uuid, requestId: req, name: z.string().max(200).optional(), phone: z.string().max(60).optional(),
    email: z.string().max(200).optional(), source: z.string().max(100).optional(), campaign: z.string().max(100).optional(),
    status: z.string().max(40).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  }).safeParse(obj(fd));
  if (!p.success) return { error: "Check the fields and try again." };
  try {
    const ctx = await requireCtx();
    const r = await updateLead(ctx, p.data);
    if (!("unchanged" in r && r.unchanged) && !r.duplicate) after(() => pushLeadNow(p.data.leadId)); // two-way sheets get the edit in seconds
    return done("unchanged" in r && r.unchanged ? "Nothing to change." : "Saved.");
  } catch (e) { return fail(e); }
}

export async function noteAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ leadId: uuid, requestId: req, text: z.string().max(2000) }).safeParse(obj(fd));
  if (!p.success) return { error: "Write a note first." };
  try {
    const ctx = await requireCtx();
    const r = await addNote(ctx, p.data);
    if (!r.duplicate) after(() => pushLeadNow(p.data.leadId));
    return done("Note added.");
  } catch (e) { return fail(e); }
}

export async function milestoneAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({
    leadId: uuid, requestId: req, on: z.enum(["1", "0"]),
    milestone: z.enum(["appDownloadedAt", "referralSharedAt", "cardPurchasedAt", "spendingStartedAt"]),
  }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid milestone." };
  try {
    const ctx = await requireCtx();
    await setMilestone(ctx, { ...p.data, on: p.data.on === "1" });
    return done("Updated.");
  } catch (e) { return fail(e); }
}

export async function bulkAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({
    kind: z.enum(["assign", "reschedule"]), requestId: req, ids: z.string().min(36),
    ownerId: z.string().uuid().or(z.literal("")).optional(), hours: z.coerce.number().min(1).max(24 * 30).optional(),
  }).safeParse(obj(fd));
  if (!p.success) return { error: "Select leads and choose an action." };
  const ids = p.data.ids.split(",").filter((x) => uuid.safeParse(x).success);
  if (!ids.length) return { error: "Select at least one lead." };
  try {
    const ctx = await requireCtx();
    const r = p.data.kind === "assign"
      ? await bulkAssign(ctx, ids, p.data.ownerId || null, p.data.requestId)
      : await bulkReschedule(ctx, ids, p.data.hours ?? 24, p.data.requestId);
    revalidatePath("/", "layout");
    return r.failed.length ? { ok: true, message: `${r.done} updated, ${r.failed.length} skipped.`, error: r.failed[0].split(": ")[1] } : { ok: true, message: `${r.done} updated.` };
  } catch (e) { return fail(e); }
}
