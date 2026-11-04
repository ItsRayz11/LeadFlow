import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
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

/** Resolves the signed-in user to an active workspace member, or null when they have no access. */
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

  // Membership is created only by the registration hook (first admin with setup token, or an accepted invitation).
  return null;
});

export async function requireCtx(): Promise<Ctx> {
  const c = await getCtx();
  if (!c) redirect("/login");
  return c;
}

export const canManage = (c: Ctx) => c.role === "admin" || c.role === "manager";
export const canWrite = (c: Ctx) => c.role !== "viewer";
