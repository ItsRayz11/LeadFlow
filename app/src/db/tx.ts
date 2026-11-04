import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

/**
 * Transactional client (WebSocket pool). The HTTP client in ./index cannot run multi-statement
 * transactions, so every state transition in the follow-up engine goes through this one.
 */
const g = globalThis as unknown as { __lfPool?: Pool };
const pool = g.__lfPool ?? new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") g.__lfPool = pool;

export const dbTx = drizzle(pool, { schema });
export type Tx = Parameters<Parameters<typeof dbTx.transaction>[0]>[0];
