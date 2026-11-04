import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";

export type Ctx = {
  userId: string;
  memberId: string;
  name: string;
  role: "admin" | "manager" | "bd" | "viewer";
  workspaceId: string;
  tz: string;
};

/**
 * Resolves the signed-in user to a workspace member.
 * First user ever becomes admin of a new workspace; later users need an invite.
 */
export const getCtx = cache(async (): Promise<Ctx | null> => {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) return null;
  const u = s.user;

  const [m] = await db
    .select({ m: schema.workspaceMember, w: schema.workspace })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    .where(and(eq(schema.workspaceMember.userId, u.id), eq(schema.workspaceMember.active, true)))
    .limit(1);
  if (m) return { userId: u.id, memberId: m.m.id, name: m.m.displayName, role: m.m.role, workspaceId: m.w.id, tz: m.w.timezone };

  const [anyWs] = await db.select({ id: schema.workspace.id }).from(schema.workspace).limit(1);
  if (!anyWs) {
    const [w] = await db.insert(schema.workspace).values({ name: "LeadFlow" }).returning();
    const [mm] = await db
      .insert(schema.workspaceMember)
      .values({ workspaceId: w.id, userId: u.id, role: "admin", displayName: u.name })
      .returning();
    return { userId: u.id, memberId: mm.id, name: mm.displayName, role: "admin", workspaceId: w.id, tz: w.timezone };
  }

  const [inv] = await db
    .select()
    .from(schema.invite)
    .where(sql`lower(${schema.invite.email}) = ${u.email.toLowerCase()}`)
    .limit(1);
  if (!inv) return null;
  const [mm] = await db
    .insert(schema.workspaceMember)
    .values({ workspaceId: inv.workspaceId, userId: u.id, role: inv.role, displayName: inv.displayName })
    .onConflictDoNothing()
    .returning();
  const [w] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, inv.workspaceId));
  const member = mm ?? (await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.userId, u.id)))[0];
  return { userId: u.id, memberId: member.id, name: member.displayName, role: member.role, workspaceId: w.id, tz: w.timezone };
});

export async function requireCtx(): Promise<Ctx> {
  const c = await getCtx();
  if (!c) redirect("/login");
  return c;
}

export const canManage = (c: Ctx) => c.role === "admin" || c.role === "manager";
export const canWrite = (c: Ctx) => c.role !== "viewer";
