/**
 * The "where your leads stand" numbers and the lead-list views behind them, against the isolated staging database.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/pipeline.int.test.ts
 * Every row carries a unique source tag and every query is filtered by it, so other staging data cannot interfere.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

d("pipeline and lead views (database)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  let ins: typeof import("@/lib/insights");
  let leads: typeof import("@/lib/leads");
  let ctx: import("@/lib/session").Ctx;
  const tag = `PIPE${crypto.randomUUID().slice(0, 6)}`;
  const ids: Record<string, string> = {};

  const mk = async (key: string, o: Partial<typeof schema.lead.$inferInsert>) => {
    const [l] = await db.insert(schema.lead).values({ workspaceId: ctx.workspaceId, name: `PIPE ${key}`, source: tag, acquiredAt: new Date(), ownerId: ctx.memberId, ...o }).returning();
    ids[key] = l.id;
    return l;
  };
  const act = (leadId: string, o: Partial<typeof schema.leadActivity.$inferInsert>) =>
    db.insert(schema.leadActivity).values({ leadId, workspaceId: ctx.workspaceId, type: "contacted", actorId: null, summary: "t", ...o });

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    ({ eq } = await import("drizzle-orm"));
    ins = await import("@/lib/insights");
    leads = await import("@/lib/leads");
    const [m] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    const [w] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, m.workspaceId));
    ctx = { userId: m.userId, memberId: m.id, name: m.displayName, role: "admin", workspaceId: m.workspaceId, tz: w.timezone };
    const closed = { closedAt: new Date() };
    await mk("new", {});
    await mk("interested", { status: "interested", firstContactedAt: new Date() });
    await mk("converted", { status: "converted", outcome: "converted", convertedAt: new Date(), ...closed });
    // lost after interest, proven by an outcome logged in the CRM
    await mk("lostA", { status: "not_interested", outcome: "not_interested", closureReason: "Too expensive", ...closed });
    await act(ids.lostA, { outcome: "interested" });
    // lost after interest, proven by a status that moved to interested (as the sheet import records it)
    await mk("lostB", { status: "no_response", outcome: "no_response", ...closed });
    await act(ids.lostB, { type: "synced", data: { status: "interested" } });
    // lost, and nothing on record says they were ever interested
    await mk("lostC", { status: "not_interested", outcome: "not_interested", ...closed });
    // a status change typed in the CRM to interested
    await mk("lostD", { status: "cold", outcome: "dropped", ...closed });
    await act(ids.lostD, { type: "status_changed", data: { changes: { status: { from: "contacted", to: "interested" } } } });
  });
  afterAll(async () => {
    if (!RUN) return;
    for (const id of Object.values(ids)) await db.delete(schema.lead).where(eq(schema.lead.id, id));
  });

  const f = () => ({ period: "30d" as const, source: tag });

  it("counts how far leads got, and who dropped after showing interest", async () => {
    const p = await ins.pipeline(ctx, f());
    expect(p.total).toBe(7);
    expect(p.active).toBe(2);
    expect(p.contacted).toBe(6); // everyone except the new one
    expect(p.interestedNow).toBe(1);
    expect(p.converted).toBe(1);
    expect(p.interestedEver).toBe(5); // interested, converted, lostA, lostB, lostD (not lostC, not new)
    expect(p.lost).toBe(4);
    expect(p.lostAfterInterest).toBe(3); // lostA, lostB, lostD
    expect(p.lostNotInterested).toBe(2);
    expect(p.lostNoResponse).toBe(1);
    expect(p.lostOther).toBe(1); // the cold one
    expect(p.reasons).toEqual([{ reason: "Too expensive", n: 1 }]);
    expect(Object.fromEntries(p.statuses.map((x) => [x.key, x.n]))).toMatchObject({ new: 1, interested: 1, converted: 1, not_interested: 2, no_response: 1, cold: 1 });
  });

  it("every dashboard number opens the matching leads", async () => {
    const names = async (seg: import("@/lib/leads").Seg) => (await leads.listLeads(ctx, seg, "PIPE")).filter((l) => l.source === tag).map((l) => l.name.replace("PIPE ", "")).sort();
    expect(await names("interested")).toEqual(["interested"]);
    expect(await names("converted")).toEqual(["converted"]);
    expect(await names("lost")).toEqual(["lostA", "lostB", "lostC", "lostD"]);
    expect(await names("lost_interested")).toEqual(["lostA", "lostB", "lostD"]);
  });

  it("the BD view only sees their own leads", async () => {
    const other = { ...ctx, role: "bd" as const, memberId: crypto.randomUUID() };
    const p = await ins.pipeline(other, f());
    expect(p.total).toBe(0);
  });
});
