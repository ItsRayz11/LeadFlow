import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { syncConnection } from "@/lib/sheetsync";
import { pushConnection } from "@/lib/sheetwrite";
import { safeEqual } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called by the Apps Script in the sheet whenever a row is edited or added (see docs/apps-script/lead-flow-sync.gs).
 * Authenticated with a shared secret. It only triggers the same idempotent sync the worker runs, so a repeated, forged-id or
 * burst call cannot change data by itself: the sync lock collapses bursts and only connected spreadsheets are touched.
 */
export async function POST(req: Request) {
  const secret = process.env.SHEET_WEBHOOK_SECRET;
  const given = req.headers.get("x-webhook-secret") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !given || !safeEqual(given, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { spreadsheetId?: unknown } | null;
  const spreadsheetId = typeof body?.spreadsheetId === "string" ? body.spreadsheetId : "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) return NextResponse.json({ error: "Bad spreadsheetId" }, { status: 400 });

  const conns = await db.select({ id: schema.spreadsheetConnection.id }).from(schema.spreadsheetConnection)
    .where(eq(schema.spreadsheetConnection.spreadsheetId, spreadsheetId));
  if (!conns.length) return NextResponse.json({ ok: true, connections: 0 }); // unknown sheet: nothing to do, and no hint whether it exists

  const deadline = Date.now() + 45_000;
  let ran = 0;
  for (const c of conns) {
    try {
      const s = await syncConnection(c.id, "cron", undefined, deadline);
      if (s.ran) ran++;
      await pushConnection(c.id, { deadline });
    } catch (e) { console.error("sheet webhook", e); }
  }
  return NextResponse.json({ ok: true, connections: conns.length, ran });
}
