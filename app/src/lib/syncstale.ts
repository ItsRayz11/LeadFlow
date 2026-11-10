import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { syncAllConnections } from "@/lib/sheetsync";
import { pushAllTwoWay } from "@/lib/sheetwrite";

const STALE_MS = 5 * 60_000;

/** Refreshes sheets when the last good sync is older than 5 minutes. Safe to call on every page view: syncConnection holds its own overlap lock. */
export async function syncIfStale(staleMs = STALE_MS): Promise<boolean> {
  try {
    const [{ last }] = await db.select({ last: sql<string | null>`max(${schema.spreadsheetConnection.lastSuccessfulSyncAt})` }).from(schema.spreadsheetConnection);
    if (last && Date.now() - new Date(last).getTime() < staleMs) return false;
    await syncAllConnections(25_000);
    await pushAllTwoWay(10_000);
    return true;
  } catch (e) { console.error("stale sync failed", e); return false; }
}
