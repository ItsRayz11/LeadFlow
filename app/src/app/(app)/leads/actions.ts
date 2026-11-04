"use server";
import { redirect } from "next/navigation";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { canManage, canWrite, requireCtx } from "@/lib/session";
import { normalizePhone } from "@/lib/phone";

const Input = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200),
  phone: z.string().trim().max(60).optional(),
  email: z.string().trim().max(200).optional(),
  source: z.string().trim().max(100).optional(),
  campaign: z.string().trim().max(100).optional(),
  ownerId: z.string().uuid().optional().or(z.literal("")),
  force: z.string().optional(),
});

export type FormState = { error?: string; dupId?: string; dupName?: string } | undefined;

export async function createLead(_prev: FormState, fd: FormData): Promise<FormState> {
  const c = await requireCtx();
  if (!canWrite(c)) return { error: "Your role is read-only." };
  const parsed = Input.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const v = parsed.data;

  const phoneNorm = normalizePhone(v.phone);
  const emailNorm = v.email ? v.email.toLowerCase() : null;

  // Duplicate check: same normalized phone or email in this workspace. Never merges automatically.
  if (!v.force && (phoneNorm || emailNorm)) {
    const [dup] = await db
      .select({ id: schema.lead.id, name: schema.lead.name })
      .from(schema.lead)
      .where(and(
        eq(schema.lead.workspaceId, c.workspaceId),
        isNull(schema.lead.mergedIntoId),
        sql`(${phoneNorm ? sql`${schema.lead.phoneNorm} = ${phoneNorm}` : sql`false`} or ${emailNorm ? sql`${schema.lead.emailNorm} = ${emailNorm}` : sql`false`})`,
      ))
      .limit(1);
    if (dup) return { error: "A lead with this phone or email already exists.", dupId: dup.id, dupName: dup.name };
  }

  // BDs own what they create. Managers and admins may pick an owner or leave it unassigned.
  const ownerId = c.role === "bd" ? c.memberId : v.ownerId || null;
  if (ownerId) {
    const [m] = await db.select({ id: schema.workspaceMember.id }).from(schema.workspaceMember)
      .where(and(eq(schema.workspaceMember.id, ownerId), eq(schema.workspaceMember.workspaceId, c.workspaceId)));
    if (!m) return { error: "That owner is not in this workspace." };
  }

  const now = new Date();
  const [lead] = await db.insert(schema.lead).values({
    workspaceId: c.workspaceId,
    name: v.name,
    phoneRaw: v.phone || null,
    phoneNorm,
    email: v.email || null,
    emailNorm,
    source: v.source || "Manual",
    campaign: v.campaign || null,
    ownerId,
    acquiredAt: now,
    // First-contact task is due an hour after creation when someone owns the lead.
    nextFollowUpAt: ownerId ? new Date(now.getTime() + 3600e3) : null,
    createdBy: c.userId,
    updatedBy: c.userId,
  }).returning({ id: schema.lead.id });

  await db.insert(schema.leadActivity).values([
    { leadId: lead.id, workspaceId: c.workspaceId, type: "created", actorId: c.userId, summary: "Lead added by hand", idempotencyKey: "created" },
  ]);
  if (ownerId) {
    await db.insert(schema.followUpTask).values({
      workspaceId: c.workspaceId, leadId: lead.id, step: "contact_started", ownerId,
      dueAt: new Date(now.getTime() + 3600e3), dedupeKey: `${lead.id}:contact_started:0`,
    }).onConflictDoNothing();
  }
  redirect(`/leads/${lead.id}`);
}

export async function listOwners() {
  const c = await requireCtx();
  if (!canManage(c)) return [];
  return db.select({ id: schema.workspaceMember.id, name: schema.workspaceMember.displayName })
    .from(schema.workspaceMember)
    .where(and(eq(schema.workspaceMember.workspaceId, c.workspaceId), eq(schema.workspaceMember.active, true), sql`${schema.workspaceMember.role} <> 'viewer'`));
}
