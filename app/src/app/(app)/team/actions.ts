"use server";
import { revalidatePath } from "next/cache";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireCtx, type Ctx } from "@/lib/session";
import { EngineError, assignLead } from "@/lib/engine";
import { newToken, sha256 } from "@/lib/tokens";
import { readSettings } from "@/lib/schedule";
import type { R } from "../actions";

const uuid = z.string().uuid();
const fail = (e: unknown): R => {
  if (e instanceof EngineError) return { error: e.message };
  console.error(e);
  return { error: "Something went wrong. Nothing was changed." };
};
const ok = (message: string, extra: Partial<NonNullable<R>> = {}): R => {
  revalidatePath("/", "layout");
  return { ok: true, message, ...extra };
};
const obj = (fd: FormData) => Object.fromEntries(fd) as Record<string, string>;

async function admin(): Promise<Ctx> {
  const c = await requireCtx();
  if (c.role !== "admin") throw new EngineError("Only admins can do this.");
  return c;
}

async function activeAdmins(workspaceId: string) {
  const [{ n }] = await db.select({ n: count() }).from(schema.workspaceMember)
    .where(and(eq(schema.workspaceMember.workspaceId, workspaceId), eq(schema.workspaceMember.role, "admin"), eq(schema.workspaceMember.active, true)));
  return n;
}

export async function inviteAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({
    email: z.string().trim().toLowerCase().email("Enter a valid email."), displayName: z.string().trim().min(1, "Enter a name.").max(80),
    role: z.enum(["manager", "bd", "viewer", "admin"]),
  }).safeParse(obj(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const c = await admin();
    const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${p.data.email}`);
    if (existing) return { error: "That email already has an account." };
    const token = newToken();
    await db.update(schema.invite).set({ revokedAt: new Date() })
      .where(and(eq(schema.invite.workspaceId, c.workspaceId), sql`lower(${schema.invite.email}) = ${p.data.email}`, isNull(schema.invite.acceptedAt), isNull(schema.invite.revokedAt)));
    await db.insert(schema.invite).values({
      workspaceId: c.workspaceId, email: p.data.email, role: p.data.role, displayName: p.data.displayName,
      tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86400000), invitedBy: c.userId,
    });
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "invite.create", entity: "invite", data: { email: p.data.email, role: p.data.role } });
    const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
    return ok("Invitation created. Copy the link now. It is shown once and expires in 7 days.", { link: `${base}/accept?token=${token}` });
  } catch (e) { return fail(e); }
}

export async function revokeInviteAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ id: uuid }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid invitation." };
  try {
    const c = await admin();
    await db.update(schema.invite).set({ revokedAt: new Date() })
      .where(and(eq(schema.invite.id, p.data.id), eq(schema.invite.workspaceId, c.workspaceId), isNull(schema.invite.acceptedAt)));
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "invite.revoke", entity: "invite", entityId: p.data.id });
    return ok("Invitation revoked.");
  } catch (e) { return fail(e); }
}

export async function setRoleAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ memberId: uuid, role: z.enum(["admin", "manager", "bd", "viewer"]) }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid role." };
  try {
    const c = await admin();
    const [m] = await db.select().from(schema.workspaceMember).where(and(eq(schema.workspaceMember.id, p.data.memberId), eq(schema.workspaceMember.workspaceId, c.workspaceId)));
    if (!m) return { error: "Member not found." };
    if (m.role === "admin" && p.data.role !== "admin" && (await activeAdmins(c.workspaceId)) <= 1) return { error: "There must be at least one admin." };
    await db.update(schema.workspaceMember).set({ role: p.data.role }).where(eq(schema.workspaceMember.id, m.id));
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "member.role", entity: "member", entityId: m.id, data: { from: m.role, to: p.data.role } });
    return ok("Role updated.");
  } catch (e) { return fail(e); }
}

export async function deactivateAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ memberId: uuid, reassignTo: z.string().uuid().or(z.literal("")) , requestId: z.string().min(8) }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await admin();
    const [m] = await db.select().from(schema.workspaceMember).where(and(eq(schema.workspaceMember.id, p.data.memberId), eq(schema.workspaceMember.workspaceId, c.workspaceId)));
    if (!m) return { error: "Member not found." };
    if (m.id === c.memberId) return { error: "You cannot deactivate yourself." };
    if (m.role === "admin" && (await activeAdmins(c.workspaceId)) <= 1) return { error: "There must be at least one admin." };
    if (p.data.reassignTo === m.id) return { error: "Choose a different person to take over." };

    // Move their open leads (and open follow-ups) first, one transaction per lead, so nothing is orphaned silently.
    const open = await db.select({ id: schema.lead.id }).from(schema.lead)
      .where(and(eq(schema.lead.ownerId, m.id), isNull(schema.lead.closedAt), isNull(schema.lead.mergedIntoId))).limit(500);
    let moved = 0;
    for (const l of open) {
      await assignLead(c, { leadId: l.id, ownerId: p.data.reassignTo || null, requestId: `deact:${p.data.requestId}:${l.id}`, reason: `${m.displayName} was deactivated` });
      moved++;
    }
    await db.update(schema.workspaceMember).set({ active: false, deactivatedAt: new Date() }).where(eq(schema.workspaceMember.id, m.id));
    await db.delete(schema.session).where(eq(schema.session.userId, m.userId)); // sign them out everywhere
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "member.deactivate", entity: "member", entityId: m.id, data: { leadsMoved: moved, to: p.data.reassignTo || null } });
    return ok(`${m.displayName} deactivated. ${moved} open lead${moved === 1 ? "" : "s"} ${p.data.reassignTo ? "reassigned" : "left unassigned"}.`);
  } catch (e) { return fail(e); }
}

export async function reactivateAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ memberId: uuid }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await admin();
    await db.update(schema.workspaceMember).set({ active: true, deactivatedAt: null })
      .where(and(eq(schema.workspaceMember.id, p.data.memberId), eq(schema.workspaceMember.workspaceId, c.workspaceId)));
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "member.reactivate", entity: "member", entityId: p.data.memberId });
    return ok("Member reactivated.");
  } catch (e) { return fail(e); }
}

export async function aliasAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ alias: z.string().trim().min(1, "Enter the name as it appears in the sheet.").max(80), memberId: uuid.or(z.literal("")) }).safeParse(obj(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const c = await admin();
    if (p.data.memberId) {
      const [m] = await db.select({ id: schema.workspaceMember.id }).from(schema.workspaceMember).where(and(eq(schema.workspaceMember.id, p.data.memberId), eq(schema.workspaceMember.workspaceId, c.workspaceId)));
      if (!m) return { error: "Member not found." };
    }
    const updated = await db.update(schema.identityAlias).set({ memberId: p.data.memberId || null })
      .where(and(eq(schema.identityAlias.workspaceId, c.workspaceId), sql`lower(${schema.identityAlias.alias}) = ${p.data.alias.toLowerCase()}`)).returning({ id: schema.identityAlias.id });
    if (!updated.length) await db.insert(schema.identityAlias).values({ workspaceId: c.workspaceId, alias: p.data.alias, memberId: p.data.memberId || null, createdBy: c.userId }).onConflictDoNothing();
    return ok(p.data.memberId ? "Name mapped." : "Name saved as unmapped.");
  } catch (e) { return fail(e); }
}

export async function aliasDeleteAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({ id: uuid }).safeParse(obj(fd));
  if (!p.success) return { error: "Invalid request." };
  try {
    const c = await admin();
    await db.delete(schema.identityAlias).where(and(eq(schema.identityAlias.id, p.data.id), eq(schema.identityAlias.workspaceId, c.workspaceId)));
    return ok("Mapping removed.");
  } catch (e) { return fail(e); }
}

export async function settingsAction(_p: R, fd: FormData): Promise<R> {
  const p = z.object({
    h24: z.coerce.number().min(1).max(720), h48: z.coerce.number().min(1).max(720), hFinal: z.coerce.number().min(1).max(720),
    minGapMin: z.coerce.number().min(0).max(1440), retryNoAnswerMin: z.coerce.number().min(1).max(10080), maxNoAnswer: z.coerce.number().int().min(1).max(10),
    firstContactMin: z.coerce.number().min(1).max(10080), escalateAfterMin: z.coerce.number().min(1).max(10080), advanceReminderMin: z.coerce.number().min(0).max(1440),
    followUpDays: z.coerce.number().int().min(1).max(90),
    quietStart: z.string().regex(/^\d{2}:\d{2}$/), quietEnd: z.string().regex(/^\d{2}:\d{2}$/), quietEnabled: z.string().optional(),
    timezone: z.string().refine((z) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch { return false; } }, "Unknown time zone."),
  }).safeParse(obj(fd));
  if (!p.success) return { error: p.error.issues[0].message || "Check the numbers." };
  const d = p.data;
  if (!(d.h24 < d.h48 && d.h48 < d.hFinal)) return { error: "Intervals must increase: 24H < 48H < final." };
  try {
    const c = await admin();
    const next = readSettings({ ...d, quiet: { enabled: d.quietEnabled === "on", start: d.quietStart, end: d.quietEnd } });
    await db.update(schema.workspace).set({ timezone: d.timezone, settings: sql`coalesce(${schema.workspace.settings}, '{}'::jsonb) || ${JSON.stringify(next)}::jsonb` })
      .where(eq(schema.workspace.id, c.workspaceId));
    await db.insert(schema.auditLog).values({ workspaceId: c.workspaceId, actorId: c.userId, action: "settings.update", entity: "workspace", data: next });
    return ok("Settings saved. New intervals apply to follow-ups scheduled from now on.");
  } catch (e) { return fail(e); }
}

export async function markReadAction(_p: R, fd: FormData): Promise<R> {
  const c = await requireCtx();
  const id = fd.get("id");
  const cond = typeof id === "string" && uuid.safeParse(id).success ? eq(schema.notification.id, id) : undefined;
  await db.update(schema.notification).set({ readAt: new Date() })
    .where(and(eq(schema.notification.memberId, c.memberId), isNull(schema.notification.readAt), cond));
  return ok("Marked as read.");
}

