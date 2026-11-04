/**
 * Integration tests for the follow-up engine against the isolated staging database.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/engine.int.test.ts
 * They need an existing workspace (the e2e suite creates one) and clean up the leads they create.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

d("follow-up engine (database)", () => {
  let ctx: import("@/lib/session").Ctx;
  let mgr: import("@/lib/session").Ctx;
  const created: string[] = [];
  let eng: typeof import("@/lib/engine");
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let leads: typeof import("@/lib/leads");
  let eq: typeof import("drizzle-orm").eq;
  let sql: typeof import("drizzle-orm").sql;
  const rid = () => crypto.randomUUID();

  async function mkLead(name: string, opts: { acquiredAt?: Date } = {}) {
    const [l] = await db.insert(schema.lead).values({
      workspaceId: ctx.workspaceId, name: `INT ${name} ${rid().slice(0, 6)}`, source: "int", ownerId: ctx.memberId, acquiredAt: opts.acquiredAt ?? new Date(),
    }).returning();
    created.push(l.id);
    await db.insert(schema.followUpTask).values({ workspaceId: ctx.workspaceId, leadId: l.id, step: "contact_started", ownerId: ctx.memberId, dueAt: new Date(Date.now() + 3600e3), dedupeKey: `${l.id}:contact_started:0` });
    return l;
  }
  const tasks = (id: string) => db.select().from(schema.followUpTask).where(eq(schema.followUpTask.leadId, id)).orderBy(schema.followUpTask.createdAt);
  const acts = (id: string) => db.select().from(schema.leadActivity).where(eq(schema.leadActivity.leadId, id));

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    ({ eq, sql } = await import("drizzle-orm"));
    eng = await import("@/lib/engine");
    leads = await import("@/lib/leads");
    const [m] = await db.select({ m: schema.workspaceMember, w: schema.workspace }).from(schema.workspaceMember)
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId)).where(eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace with an admin exists.");
    ctx = { userId: m.m.userId, memberId: m.m.id, name: m.m.displayName, role: "admin", workspaceId: m.w.id, tz: m.w.timezone };
    mgr = { ...ctx, role: "manager" };
  });

  afterAll(async () => {
    if (!RUN) return;
    for (const id of created) await db.delete(schema.lead).where(eq(schema.lead.id, id));
  });

  it("double-submitting the same request applies exactly once", async () => {
    const l = await mkLead("double");
    const requestId = rid();
    const input = { leadId: l.id, requestId, outcome: "reached" as const, channel: "call" as const };
    const results = await Promise.all([eng.recordOutcome(ctx, input), eng.recordOutcome(ctx, input), eng.recordOutcome(ctx, input)]);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const t = await tasks(l.id);
    expect(t.map((x) => `${x.step}:${x.status}`)).toEqual(["contact_started:completed", "h24:pending"]);
    const a = (await acts(l.id)).filter((x) => x.idempotencyKey === `outcome:${requestId}`);
    expect(a).toHaveLength(1);
    const [row] = await db.select().from(schema.lead).where(eq(schema.lead.id, l.id));
    expect(row.followUpAttempts).toBe(1);
  });

  it("simultaneous edits by two people serialize and never leave two open tasks", async () => {
    const l = await mkLead("race");
    await Promise.all([
      eng.recordOutcome(ctx, { leadId: l.id, requestId: rid(), outcome: "reached", channel: "call" }),
      eng.recordOutcome(mgr, { leadId: l.id, requestId: rid(), outcome: "reached", channel: "whatsapp" }),
    ]);
    const t = await tasks(l.id);
    expect(t.filter((x) => x.status === "pending")).toHaveLength(1);
    expect(t.map((x) => x.step)).toEqual(["contact_started", "h24", "h48"]); // each request advanced one step, in order
    const [row] = await db.select().from(schema.lead).where(eq(schema.lead.id, l.id));
    expect(row.followUpAttempts).toBe(2);
    expect(row.version).toBeGreaterThanOrEqual(3);
  });

  it("parallel reschedules leave a single pending task and keep the rest as history", async () => {
    const l = await mkLead("resched");
    const at = (h: number) => new Date(Date.now() + h * 3600e3);
    await Promise.all([1, 2, 3, 4, 5].map((h) => eng.scheduleNext(ctx, { leadId: l.id, requestId: rid(), at: at(h + 1) })));
    const t = await tasks(l.id);
    expect(t.filter((x) => x.status === "pending")).toHaveLength(1);
    expect(t.filter((x) => x.status === "rescheduled")).toHaveLength(5);
    expect(new Set(t.map((x) => x.dedupeKey)).size).toBe(t.length); // no duplicate task keys
  });

  it("no answer never closes the lead; the sequence moves on after the limit", async () => {
    const l = await mkLead("noanswer");
    for (let i = 0; i < 3; i++) await eng.recordOutcome(ctx, { leadId: l.id, requestId: rid(), outcome: "no_answer", channel: "call" });
    const [row] = await db.select().from(schema.lead).where(eq(schema.lead.id, l.id));
    expect(row.closedAt).toBeNull();
    expect(row.firstContactedAt).toBeNull();
    expect(row.followUpAttempts).toBe(3);
    const t = await tasks(l.id);
    expect(t.map((x) => `${x.step}:${x.status}`)).toEqual(["contact_started:completed", "h24:pending"]);
  });

  it("closing twice is idempotent, reopening restores one open task, and history is kept", async () => {
    const l = await mkLead("close");
    const r = rid();
    await Promise.all([eng.closeLead(ctx, { leadId: l.id, outcome: "dropped", requestId: r }), eng.closeLead(ctx, { leadId: l.id, outcome: "dropped", requestId: r })]);
    expect((await tasks(l.id)).map((x) => x.status)).toEqual(["cancelled"]);
    await eng.reopenLead(ctx, { leadId: l.id, requestId: rid() });
    const t = await tasks(l.id);
    expect(t.filter((x) => x.status === "pending")).toHaveLength(1);
    expect((await acts(l.id)).filter((x) => x.type === "closed")).toHaveLength(1);
  });

  it("BDs cannot act on someone else's lead; viewers cannot act at all", async () => {
    const l = await mkLead("perm");
    const other = { ...ctx, role: "bd" as const, memberId: crypto.randomUUID() };
    await expect(eng.recordOutcome(other, { leadId: l.id, requestId: rid(), outcome: "reached", channel: "call" })).rejects.toThrow(/belongs to someone else/);
    await expect(eng.recordOutcome({ ...ctx, role: "viewer" }, { leadId: l.id, requestId: rid(), outcome: "reached", channel: "call" })).rejects.toThrow(/read-only/);
    await expect(eng.assignLead({ ...ctx, role: "bd" }, { leadId: l.id, ownerId: null, requestId: rid() })).rejects.toThrow(/managers and admins/);
  });

  it("daily counts follow the workspace time zone, not UTC", async () => {
    // A lead acquired at 00:10 Karachi time today is the previous day in UTC (19:10).
    const r = await db.execute(sql`select ((date_trunc('day', now() at time zone 'Asia/Karachi') + interval '10 minutes') at time zone 'Asia/Karachi') as t`);
    const acquiredAt = new Date((r.rows[0] as { t: Date }).t);
    await mkLead("tz", { acquiredAt });
    const dayKey = (tz: string, x: Date) => x.toLocaleDateString("en-CA", { timeZone: tz });
    const inKarachiToday = dayKey("Asia/Karachi", acquiredAt) === dayKey("Asia/Karachi", new Date());
    const inUtcToday = dayKey("UTC", acquiredAt) === dayKey("UTC", new Date());
    expect(inKarachiToday).toBe(true);

    const countToday = async (tz: string) => {
      const q = await db.execute(sql`select count(*)::int n from lead where workspace_id = ${ctx.workspaceId} and (acquired_at at time zone ${tz})::date = (now() at time zone ${tz})::date`);
      return (q.rows[0] as { n: number }).n;
    };
    const karachi = await leads.overviewMetrics({ ...ctx, tz: "Asia/Karachi" });
    const utc = await leads.overviewMetrics({ ...ctx, tz: "UTC" });
    expect(karachi.newToday).toBe(await countToday("Asia/Karachi"));
    expect(utc.newToday).toBe(await countToday("UTC"));
    // When the zones disagree about this lead's day, the dashboard counts must disagree too.
    if (inKarachiToday !== inUtcToday) expect(karachi.newToday).not.toBe(utc.newToday);
  });
});
