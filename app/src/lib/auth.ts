import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { count, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  plugins: [nextCookies()],
  databaseHooks: {
    user: {
      create: {
        // Sign-up is closed once a workspace exists, unless an admin invited this email.
        before: async (u) => {
          const [{ n }] = await db.select({ n: count() }).from(schema.workspace);
          if (n === 0) return;
          const [inv] = await db
            .select({ id: schema.invite.id })
            .from(schema.invite)
            .where(eq(sql`lower(${schema.invite.email})`, u.email.toLowerCase()))
            .limit(1);
          if (!inv) throw new APIError("FORBIDDEN", { message: "This email has not been invited. Ask an admin to invite you." });
        },
      },
    },
  },
});
