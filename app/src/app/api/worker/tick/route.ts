import { NextResponse } from "next/server";
import { sweep } from "@/lib/sweep";
import { syncAllConnections } from "@/lib/sheetsync";
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
    return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result, sheets });
  } catch (e) {
    console.error("worker tick failed", e);
    return NextResponse.json({ ok: false, error: "Worker failed" }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
