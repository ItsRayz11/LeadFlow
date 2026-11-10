import { NextResponse } from "next/server";
import { sweep } from "@/lib/sweep";
import { syncAllConnections } from "@/lib/sheetsync";
import { pushAllTwoWay } from "@/lib/sheetwrite";
import { safeEqual } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Pluggable worker entry point. Any scheduler can call it: Vercel Cron (daily on the free plan),
 * a GitHub Actions schedule, cron-job.org, a VPS cron, or a Cloudflare Worker.
 * It is idempotent, so calling it every minute, or twice at once, is safe.
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !given || !safeEqual(given, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await sweep();
    // A failing sheet must never block reminders, so sync errors are reported, not thrown.
    const sheets = await syncAllConnections(30_000).catch(() => ({ connections: 0, created: 0, failed: 1, skipped: 0 }));
    // After reading the sheet, send CRM edits back (two-way connections only). Also reported, never thrown.
    const writeback = await pushAllTwoWay(15_000).catch(() => ({ updated: 0, adopted: 0, conflicts: 0, appended: 0, skipped: 0, errors: ["write-back failed"] }));
    return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result, sheets, writeback });
  } catch (e) {
    console.error("worker tick failed", e);
    return NextResponse.json({ ok: false, error: "Worker failed" }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
