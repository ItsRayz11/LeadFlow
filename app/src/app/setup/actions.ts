"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { count } from "drizzle-orm";
import { db, schema } from "@/db";
import { dbTx } from "@/db/tx";
import { auth } from "@/lib/auth";
import { safeEqual } from "@/lib/tokens";
import type { R } from "@/app/(app)/actions";

/**
 * Recovery for an interrupted first-admin registration.
 * If sign-up created the owner's user but the workspace was never created, the owner can sign in and
 * finish setup here. The same three gates apply as at registration: nobody has a workspace yet,
 * the signed-in email is OWNER_EMAIL, and the one-time SETUP_TOKEN is correct.
 */
export async function finishSetupAction(_p: R, fd: FormData): Promise<R> {
  const owner = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const setup = process.env.SETUP_TOKEN;
  const given = String(fd.get("token") ?? "");
  const fail = (error: string): R => ({ error });

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return fail("Sign in with the owner account first.");
  if (!owner || !setup || session.user.email.toLowerCase() !== owner || !given || !safeEqual(given, setup)) {
    return fail("Setup could not be completed. Check the owner account and the setup token.");
  }
  const [{ n }] = await db.select({ n: count() }).from(schema.workspace);
  if (n > 0) return fail("This workspace is already set up.");

  try {
    const done = await dbTx.transaction(async (tx) => {
      const [w] = await tx.insert(schema.workspace).values({ name: "LeadFlow" }).onConflictDoNothing().returning();
      if (!w) return false; // another request won the race: the singleton constraint allows only one workspace
      await tx.insert(schema.workspaceMember).values({ workspaceId: w.id, userId: session.user.id, role: "admin", displayName: session.user.name });
      await tx.insert(schema.auditLog).values({ workspaceId: w.id, actorId: session.user.id, action: "setup.recovered", entity: "workspace" });
      return true;
    });
    if (!done) return fail("This workspace is already set up.");
  } catch (e) {
    console.error("finishSetup failed", e);
    return fail("Something went wrong. Nothing was changed. Try again.");
  }
  revalidatePath("/", "layout");
  redirect("/"); // redirect from the server so the owner lands in the app even though /setup closes itself
}
