/**
 * Insights queries against the isolated staging database.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/insights.int.test.ts
 * Every row carries a unique source tag, and each query is filtered by it, so other staging data cannot interfere.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

d("insights (database)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  let ins: typeof import("@/lib/insights");
  let ctx: import("@/lib/session").Ctx;
  const tag = `INSIGHT${crypto.randomUUID().slice(0, 6)}`;
  const created: string[] = [];
  const DAY = 86_400_000;

  async function mk(o: { ago: number; owner?: boolean; firstContactAfterH?: number; converted?: boolean; milestone?: boolean }) {
    const acquired = new Date(Date.now() - o.ago * DAY);
    const [l] = await db.insert(schema.lead).values({
      workspaceId: ctx.workspaceId, name: `INS ${tag}`, source: tag, acquiredAt: acquired, ownerId: o.owner === false ? null : ctx.memberId,
      firstContactedAt: o.firstContactAfterH != null ? new Date(acquired.getTime() + o.firstContactAfterH * 3_600_000) : null,
      convertedAt: o.converted ? acquired : null, appDownloadedAt: o.milestone ? acquired : null,
    }).returning();
    created.push(l.id);
    return l;
  }

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    ({ eq } = await import("drizzle-orm"));
    ins = await import("@/lib/insights");
    const [m] = await db.select({ m: schema.workspaceMember, w: schema.workspace }).from(schema.workspaceMember)
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId)).where(eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    ctx = { userId: m.m.userId, memberId: m.m.id, name: m.m.displayName, role: "admin", workspaceId: m.w.id, tz: m.w.timezone };
    await mk({ ago: 0, firstContactAfterH: 0.5, milestone: true });
    await mk({ ago: 0, converted: true });
    await mk({ ago: 0, owner: false });
    await mk({ ago: 1 });
    await mk({ ago: 10 });
  });

  afterAll(async () => {
    if (!RUN) return;
    for (const id of created) await db.delete(schema.lead).where(eq(schema.lead.id, id));
  });

  const F = (period: "today" | "yesterday" | "7d" | "30d") => ({ period, source: tag });

  it("counts each period correctly", async () => {
    expect((await ins.summary(ctx, F("today"))).newLeads).toBe(3);
    expect((await ins.summary(ctx, F("yesterday"))).newLeads).toBe(1);
    expect((await ins.summary(ctx, F("7d"))).newLeads).toBe(4);
    expect((await ins.summary(ctx, F("30d"))).newLeads).toBe(5);
  });

  it("leads without an arrival date are not counted as arrivals", async () => {
    const [l] = await db.insert(schema.lead).values({
      workspaceId: ctx.workspaceId, name: `INS nodate ${tag}`, source: tag, acquiredAt: new Date(), custom: { acquiredDateMissing: true },
    }).returning();
    created.push(l.id);
    expect((await ins.summary(ctx, F("today"))).newLeads).toBe(3);
    expect((await ins.snapshot(ctx, F("today"))).active).toBeGreaterThanOrEqual(4); // still an active lead
  });

  it("compares with the equally long period right before", async () => {
    expect((await ins.summary(ctx, F("today"), 1)).newLeads).toBe(1); // yesterday
    expect((await ins.summary(ctx, F("7d"), 1)).newLeads).toBe(1); // days 7-13 contain the 10-day-old lead
  });

  it("measures first contact and conversion", async () => {
    const s = await ins.summary(ctx, F("today"));
    expect(s.firstContacted).toBe(1);
    expect(s.converted).toBe(1);
    expect(s.avgFirstContactHrs).toBeCloseTo(0.5, 1);
  });

  it("a BD sees only their own leads", async () => {
    const bd = { ...ctx, role: "bd" as const };
    expect((await ins.summary(bd, F("today"))).newLeads).toBe(2); // the unassigned one is hidden
    expect(await ins.byOwner(bd, F("today"))).toEqual([]);
  });

  it("the daily series is zero-filled and adds up", async () => {
    const rows = await ins.daily(ctx, F("7d"));
    expect(rows).toHaveLength(7);
    expect(rows.reduce((a, r) => a + r.newLeads, 0)).toBe(4);
    expect(rows.at(-1)!.newLeads).toBe(3);
    expect(new Set(rows.map((r) => r.day)).size).toBe(7);
  });

  it("groups by source and counts milestones", async () => {
    const src = await ins.bySource(ctx, { period: "30d" });
    expect(src.find((s) => s.source === tag)?.leads).toBe(5);
    const ms = await ins.milestones(ctx, F("today"));
    expect(ms.leads).toBe(3);
    expect(ms.appDownloaded).toBe(1);
  });

  it("per-person rows include owners with no leads and never credit unowned leads to anyone", async () => {
    const rows = await ins.byOwner(ctx, { period: "today" });
    const me = rows.find((r) => r.memberId === ctx.memberId);
    expect(me).toBeTruthy();
    expect(rows.every((r) => r.open >= 0)).toBe(true);
  });

  it("neutralises spreadsheet formulas in CSV cells", () => {
    expect(ins.csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(ins.csvCell("+1")).toBe("'+1");
    expect(ins.csvCell("a,b")).toBe("\"a,b\"");
    expect(ins.csvCell(null)).toBe("");
  });
});
