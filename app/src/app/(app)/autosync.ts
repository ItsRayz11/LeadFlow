"use server";
import { getCtx } from "@/lib/session";
import { syncIfStale } from "@/lib/syncstale";

/** Called by the browser timer every 10 minutes. Only signed-in members; skips if a sync finished in the last 9 minutes. */
export async function autoSyncAction(): Promise<boolean> {
  if (!(await getCtx())) return false;
  return syncIfStale(9 * 60_000);
}
