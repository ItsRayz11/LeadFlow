import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { dbTx } from "@/db/tx";
import { safeEqual, sha256 } from "@/lib/tokens";

type Hooked = { request?: Request; headers?: Headers } | null;
const headerOf = (ctx: Hooked, name: string) => (ctx?.request?.headers ?? ctx?.headers)?.get(name) ?? null;

async function findInvite(email: string, token: string | null) {
  if (!token) return null;
  const [inv] = await db.select().from(schema.invite)
    .where(and(
      eq(schema.invite.tokenHash, sha256(token)),
      eq(sql`lower(${schema.invite.email})`, email.toLowerCase()),
      isNull(schema.invite.acceptedAt), isNull(schema.invite.revokedAt),
      gt(schema.invite.expiresAt, new Date()),
    )).limit(1);
  return inv ?? null;
}

/**
 * Registration policy.
 *  - No workspace yet: only OWNER_EMAIL, and only with the one-time SETUP_TOKEN, can register. They become admin.
 *  - Workspace exists: registration needs a valid, unexpired, unrevoked invitation token for that exact email.
 * Both secrets live only in server environment variables.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  plugins: [nextCookies()],
  databaseHooks: {
    user: {
      create: {
        before: async (u, ctx) => {
          const [{ n }] = await db.select({ n: count() }).from(schema.workspace);
          if (n === 0) {
            const owner = process.env.OWNER_EMAIL, setup = process.env.SETUP_TOKEN;
            if (!owner || !setup) throw new APIError("FORBIDDEN", { message: "Setup is not configured. Registration is closed." });
            const given = headerOf(ctx as Hooked, "x-setup-token");
            if (!given || !safeEqual(given, setup) || u.email.toLowerCase() !== owner.trim().toLowerCase()) {
              throw new APIError("FORBIDDEN", { message: "Registration is closed." });
            }
            return;
          }
          const inv = await findInvite(u.email, headerOf(ctx as Hooked, "x-invite-token"));
          if (!inv) throw new APIError("FORBIDDEN", { message: "Registration is by invitation only." });
        },
        after: async (u, ctx) => {
          await dbTx.transaction(async (tx) => {
            const [{ n }] = await tx.select({ n: count() }).from(schema.workspace);
            if (n === 0) {
              // The unique "singleton" column means concurrent bootstraps cannot both create a workspace.
              const [w] = await tx.insert(schema.workspace).values({ name: "LeadFlow" }).onConflictDoNothing().returning();
              if (w) {
                await tx.insert(schema.workspaceMember).values({ workspaceId: w.id, userId: u.id, role: "admin", displayName: u.name });
                return;
              }
            }
            const inv = await findInvite(u.email, headerOf(ctx as Hooked, "x-invite-token"));
            if (!inv) return;
            const [claimed] = await tx.update(schema.invite).set({ acceptedAt: new Date() })
              .where(and(eq(schema.invite.id, inv.id), isNull(schema.invite.acceptedAt))).returning();
            if (!claimed) return;
            await tx.insert(schema.workspaceMember).values({
              workspaceId: inv.workspaceId, userId: u.id, role: inv.role, displayName: inv.displayName || u.name,
            }).onConflictDoNothing();
          });
        },
      },
    },
  },
});
