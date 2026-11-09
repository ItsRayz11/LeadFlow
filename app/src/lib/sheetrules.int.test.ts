/**
 * Ingestion rules against the isolated staging database, with Google stubbed out.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/sheetrules.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

const header = "Contacted y,Status,id,created_time,campaign_name,platform,full_name,whatsapp_number,whatsapp_number";
let body: string[] = [];
const csv = () => [header, ...body].join("\n");

d("sheet ingestion rules (database)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  let sync: typeof import("@/lib/sheetsync");
  let connId: string, memberName: string;
  const tag = crypto.randomUUID().slice(0, 6);
  const mk = (n: number) => `RUL${tag}${n}`;

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    ({ eq } = await import("drizzle-orm"));
    sync = await import("@/lib/sheetsync");
    const [m] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    memberName = m.displayName;
    const [c] = await db.insert(schema.spreadsheetConnection).values({ workspaceId: m.workspaceId, spreadsheetId: `RULSHEET${tag}`.padEnd(24, "x"), title: "RUL test" }).returning();
    connId = c.id;
    vi.stubGlobal("fetch", async () => new Response(csv(), { status: 200, headers: { "content-type": "text/csv" } }));
  });
  afterAll(async () => {
    if (!RUN) return;
    vi.unstubAllGlobals();
    await db.delete(schema.lead).where(eq(schema.lead.connectionId, connId));
    await db.delete(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connId));
  });

  it("an unconfirmed mapping is a pending state, not a failure", async () => {
    await db.insert(schema.worksheetMapping).values({ connectionId: connId, sheetGid: "1", sheetTitle: "t", enabled: true, columnMap: (await import("@/lib/sheetparse")).DEFAULT_COLUMN_MAP });
    const r = await sync.syncConnection(connId, "cron");
    expect(r.ran).toBe(false);
    const jobs = await db.select().from(schema.syncJob).where(eq(schema.syncJob.connectionId, connId));
    expect(jobs).toHaveLength(0);
    const [c] = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connId));
    expect(c.healthy).toBe(true);
    await db.update(schema.worksheetMapping).set({ confirmedAt: new Date() }).where(eq(schema.worksheetMapping.connectionId, connId));
  });

  it("history is not turned into a flood of due tasks; fresh untouched leads still get one", async () => {
    const recent = new Date(Date.now() - 86_400_000);
    const old = new Date(Date.now() - 90 * 86_400_000);
    const us = (dt: Date) => `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
    body = [
      `${memberName},,${mk(1)},${us(recent)},c,fb,Fresh One,,`,
      `${memberName},,${mk(2)},${us(old)},c,fb,Old Two,,`,
      `${memberName},⭐ Interested,${mk(3)},${us(recent)},c,fb,Worked Three,,`,
      `${memberName},,${mk(4)},,c,fb,No Date Four,,`,
    ];
    const r = await sync.syncConnection(connId, "initial");
    expect(r.created).toBe(4);
    expect(r.assigned).toBe(4);
    const rows = await db.select().from(schema.lead).where(eq(schema.lead.connectionId, connId));
    const withTask: string[] = [];
    for (const l of rows) {
      const t = await db.select().from(schema.followUpTask).where(eq(schema.followUpTask.leadId, l.id));
      if (t.length) withTask.push(l.externalId!);
    }
    expect(withTask).toEqual([mk(1)]);
    expect(rows.every((l) => l.ownerId)).toBe(true);
    expect((rows.find((l) => l.externalId === mk(4))!.custom as { acquiredDateMissing?: boolean }).acquiredDateMissing).toBe(true);
  });

  it("flags duplicates inside the same batch", async () => {
    body.push(`,,${mk(5)},11/5/2026,c,fb,Twin A,twin${tag}@example.com,`, `,,${mk(6)},11/5/2026,c,fb,Twin B,twin${tag}@example.com,`);
    const r = await sync.syncConnection(connId, "cron");
    expect(r.possibleDuplicates).toBe(1);
  });

  it("a job killed mid-run is reaped and the next sync proceeds", async () => {
    await db.insert(schema.syncJob).values({ connectionId: connId, trigger: "cron", status: "running", startedAt: new Date(Date.now() - 30 * 60_000) });
    const r = await sync.syncConnection(connId, "cron");
    expect(r.ran).toBe(true);
    const jobs = await db.select().from(schema.syncJob).where(eq(schema.syncJob.connectionId, connId));
    expect(jobs.filter((j) => j.status === "running")).toHaveLength(0);
  });

  it("does not overlap with a live sync", async () => {
    await db.insert(schema.syncJob).values({ connectionId: connId, trigger: "cron", status: "running" });
    const r = await sync.syncConnection(connId, "cron");
    expect(r.ran).toBe(false);
    await db.update(schema.syncJob).set({ status: "success" }).where(eq(schema.syncJob.connectionId, connId));
  });
});
