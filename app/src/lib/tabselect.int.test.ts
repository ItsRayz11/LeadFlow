/**
 * Choosing which tabs to sync (Integrations) and which tabs to view (Leads), against the isolated staging database with Google stubbed out.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/tabselect.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

const goodHeader = "Contacted y,Status,id,created_time,campaign_name,platform,full_name,whatsapp_number,whatsapp_number,Lead Follow Up,Notes,Card Status,onboarded";
const badHeader = "foo,bar,baz"; // no id / full_name columns
const today = (() => { const x = new Date(); return `${x.getMonth() + 1}/${x.getDate()}/${x.getFullYear()}`; })();

// Tab names as in the real spreadsheet.
const LIVE = [
  { gid: "201", title: "Facebook Instant Form - WhatsApp (Fazal)" },
  { gid: "202", title: "Facebook Instant Form - WhatsApp (Bawar)" },
  { gid: "203", title: "TikTok Ads (Fazal)" },
  { gid: "204", title: "TikTok Ads (Bawar)" },
  { gid: "205", title: "NEW --->" },
];
const BAD = new Set(["203", "205"]);

d("choosing tabs to sync and to view (database)", { timeout: 240_000 }, () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let orm: typeof import("drizzle-orm");
  let sync: typeof import("@/lib/sheetsync");
  let save: typeof import("@/lib/tabsave");
  let leadsLib: typeof import("@/lib/leads");
  let ctx: import("@/lib/session").Ctx;
  let connId: string;
  const tag = crypto.randomUUID().slice(0, 6);
  const rows: Record<string, string[]> = { "201": [], "202": [], "203": [], "204": [], "205": [] };
  const row = (gid: string, n: number) => `,,TS${tag}${gid}x${n},${today},camp,fb,Lead ${gid}-${n},,`;
  const key = (gid: string) => `${connId}:${gid}`;

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    orm = await import("drizzle-orm");
    sync = await import("@/lib/sheetsync");
    save = await import("@/lib/tabsave");
    leadsLib = await import("@/lib/leads");
    const [m] = await db.select().from(schema.workspaceMember).where(orm.eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    const [w] = await db.select().from(schema.workspace).where(orm.eq(schema.workspace.id, m.workspaceId));
    ctx = { userId: m.userId, memberId: m.id, name: m.displayName, role: "admin", workspaceId: m.workspaceId, tz: (w as { timezone?: string }).timezone ?? "Asia/Karachi" };
    const [c] = await db.insert(schema.spreadsheetConnection).values({ workspaceId: m.workspaceId, spreadsheetId: `TSSHEET${tag}`.padEnd(24, "x"), title: "TS test" }).returning();
    connId = c.id;
    rows["201"] = [row("201", 1), row("201", 2), row("201", 3)];
    rows["202"] = [row("202", 1), row("202", 2)];
    rows["204"] = [row("204", 1)];
    vi.stubGlobal("fetch", async (url: string) => {
      const gid = new URL(String(url)).searchParams.get("gid") ?? "";
      const body = BAD.has(gid) ? [badHeader, "1,2,3"] : [goodHeader, ...(rows[gid] ?? [])];
      return new Response(body.join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
    });
  });

  afterAll(async () => {
    if (!RUN) return;
    vi.unstubAllGlobals();
    await db.delete(schema.lead).where(orm.eq(schema.lead.connectionId, connId));
    await db.delete(schema.spreadsheetConnection).where(orm.eq(schema.spreadsheetConnection.id, connId));
  });

  const conn = () => ({ id: connId, spreadsheetId: `TSSHEET${tag}`.padEnd(24, "x") });
  const maps = () => db.select().from(schema.worksheetMapping).where(orm.eq(schema.worksheetMapping.connectionId, connId));
  const enabledGids = async () => (await maps()).filter((m) => m.enabled).map((m) => m.sheetGid).sort();
  const leads = () => db.select().from(schema.lead).where(orm.eq(schema.lead.connectionId, connId));
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const l of await leads()) out[l.sheetGid ?? ""] = (out[l.sheetGid ?? ""] ?? 0) + 1;
    return out;
  };
  const confirmAll = () => db.update(schema.worksheetMapping).set({ confirmedAt: new Date() }).where(orm.and(orm.eq(schema.worksheetMapping.connectionId, connId), orm.eq(schema.worksheetMapping.enabled, true)));
  const names = async (tab: string | string[], seg: import("@/lib/leads").Seg = "all") =>
    (await leadsLib.listLeads(ctx, seg, "", tab)).filter((l) => l.name.startsWith("Lead 20")).map((l) => l.name).sort();

  describe("selection", () => {
    it("a valid selected tab saves even though another available tab has missing columns", async () => {
      const r = await save.applyTabSelection(ctx, conn(), LIVE, ["201"]);
      expect(r?.ok).toBe(true);
      expect(r?.warnings).toEqual({});
      expect(await enabledGids()).toEqual(["201"]);
    });

    it("tabs that were not selected stay inactive: nothing is switched on by saving", async () => {
      const all = await maps();
      expect(all.map((m) => m.sheetGid)).toEqual(["201"]); // not even a mapping row exists for 202..205
    });

    it("the newly selected tab waits for confirmation and imports nothing until then", async () => {
      expect((await maps())[0].confirmedAt).toBeNull();
      const r = await sync.syncConnection(connId, "manual");
      expect(r.ran).toBe(false);
      expect(await leads()).toHaveLength(0);
    });

    it("selecting a valid and an invalid tab together: the valid one is saved, the invalid one gets its own named warning", async () => {
      await confirmAll();
      const r = await save.applyTabSelection(ctx, conn(), LIVE, ["201", "202", "203"]);
      expect(r?.ok).toBe(true);
      expect(await enabledGids()).toEqual(["201", "202"]);
      expect(r?.warnings?.["203"]).toMatch(/missing/);
      expect(r?.warnings?.["203"]).toContain("Lead ID");
      expect(r?.message).toContain("“TikTok Ads (Fazal)”");
      expect(r?.message).not.toMatch(/Nothing was connected/);
    });

    it("tabs that stayed selected keep their confirmation and keep syncing", async () => {
      const m = await maps();
      expect(m.find((x) => x.sheetGid === "201")?.confirmedAt).not.toBeNull();
      expect(m.find((x) => x.sheetGid === "202")?.confirmedAt).toBeNull(); // the new one waits
    });

    it("only invalid tabs selected: reports each by name and changes nothing", async () => {
      const before = await enabledGids();
      const r = await save.applyTabSelection(ctx, conn(), LIVE, [...before, "203", "205"]);
      expect(r?.error).toMatch(/Nothing changed/);
      expect(r?.error).toContain("“TikTok Ads (Fazal)”");
      expect(r?.error).toContain("“NEW --->”");
      expect(await enabledGids()).toEqual(before);
    });

    it("a tab added to the spreadsheet later is not selected automatically", async () => {
      const more = [...LIVE, { gid: "206", title: "Brand new tab" }];
      await save.applyTabSelection(ctx, conn(), more, ["201", "202"]);
      expect(await enabledGids()).toEqual(["201", "202"]);
    });

    it("saving an id-style placeholder name replaces it with the real tab name", async () => {
      await db.update(schema.worksheetMapping).set({ sheetTitle: "Worksheet 201" }).where(orm.and(orm.eq(schema.worksheetMapping.connectionId, connId), orm.eq(schema.worksheetMapping.sheetGid, "201")));
      await save.applyTabSelection(ctx, conn(), LIVE, ["201", "202"]);
      expect((await maps()).find((m) => m.sheetGid === "201")?.sheetTitle).toBe("Facebook Instant Form - WhatsApp (Fazal)");
    });
  });

  describe("three tabs at once", () => {
    it("imports each tab's rows under its own tab, with exact per-tab counts, and repeating creates no duplicates", async () => {
      await save.applyTabSelection(ctx, conn(), LIVE, ["201", "202", "204"]);
      await confirmAll();
      const first = await sync.syncConnection(connId, "manual");
      expect(first.created).toBe(6);
      expect(await counts()).toEqual({ "201": 3, "202": 2, "204": 1 });
      for (const l of await leads()) expect(l.name).toContain(`Lead ${l.sheetGid}-`);
      for (let i = 0; i < 2; i++) expect((await sync.syncConnection(connId, "cron")).created).toBe(0);
      expect(await counts()).toEqual({ "201": 3, "202": 2, "204": 1 });
    });
  });

  describe("Leads page filter", () => {
    it("lists every tab with its real name and real count, and marks status", async () => {
      const tabs = (await leadsLib.trackedTabs(ctx)).filter((t) => t.connectionId === connId);
      const by = Object.fromEntries(tabs.map((t) => [t.gid, t]));
      expect(by["201"]).toMatchObject({ title: "Facebook Instant Form - WhatsApp (Fazal)", n: 3, state: "syncing" });
      expect(by["202"]).toMatchObject({ title: "Facebook Instant Form - WhatsApp (Bawar)", n: 2 });
      expect(by["204"]).toMatchObject({ title: "TikTok Ads (Bawar)", n: 1 });
      expect(tabs.some((t) => /^Worksheet \d+$/.test(t.title))).toBe(false);
    });

    it("one tab shows only its leads", async () => {
      expect(await names(key("201"))).toEqual(["Lead 201-1", "Lead 201-2", "Lead 201-3"]);
    });
    it("two tabs show both", async () => {
      expect(await names([key("201"), key("204")])).toEqual(["Lead 201-1", "Lead 201-2", "Lead 201-3", "Lead 204-1"]);
      expect(await names(`${key("202")},${key("204")}`)).toEqual(["Lead 202-1", "Lead 202-2", "Lead 204-1"]);
    });
    it("three tabs show all three", async () => {
      expect(await names([key("201"), key("202"), key("204")])).toHaveLength(6);
    });
    it("All tabs (no selection) shows every lead, and clearing restores it", async () => {
      expect(await names("")).toHaveLength(6);
      expect(await names([])).toHaveLength(6);
    });
    it("the same gid in another spreadsheet is not mixed in", async () => {
      expect(await names("00000000-0000-4000-8000-000000000000:201")).toEqual([]);
    });
    it("rows carry the real tab name, not an id", async () => {
      const r = (await leadsLib.listLeads(ctx, "all", "", key("204"))).filter((l) => l.name.startsWith("Lead 20"));
      expect(r.map((x) => x.tabTitle)).toEqual(["TikTok Ads (Bawar)"]);
    });

    it("combines with the status filters", async () => {
      const ls = await leads();
      const target = ls.find((l) => l.name === "Lead 201-2")!;
      await db.update(schema.lead).set({ nextFollowUpAt: new Date(Date.now() - 3600e3), closedAt: null }).where(orm.eq(schema.lead.id, target.id));
      const other = ls.find((l) => l.name === "Lead 202-1")!;
      await db.update(schema.lead).set({ nextFollowUpAt: new Date(Date.now() - 3600e3), closedAt: null }).where(orm.eq(schema.lead.id, other.id));
      expect(await names(key("201"), "overdue")).toEqual(["Lead 201-2"]);
      expect(await names([key("201"), key("202")], "overdue")).toEqual(["Lead 201-2", "Lead 202-1"]);
      expect(await names(key("204"), "overdue")).toEqual([]);
      expect(await names(key("201"), "unassigned")).toEqual(await names(key("201"), "active").then((a) => a.filter((n) => ls.find((l) => l.name === n)?.ownerId == null)));
    });

    it("status counts follow the selected tabs", async () => {
      const one = await leadsLib.segCounts(ctx, key("201"));
      const two = await leadsLib.segCounts(ctx, [key("201"), key("202")]);
      expect(one.all).toBe(3);
      expect(two.all).toBe(5);
      expect(one.overdue).toBe(1);
      expect(two.overdue).toBe(2);
    });
  });

  describe("disable and re-enable", () => {
    it("switching a tab off keeps its leads and leaves the other tabs syncing", async () => {
      const r = await save.applyTabSelection(ctx, conn(), LIVE, ["201", "204"]);
      expect(r?.message).toMatch(/Stopped 1 tab/);
      expect(await enabledGids()).toEqual(["201", "204"]);
      rows["202"].push(row("202", 3)); // new row on the stopped tab
      rows["201"].push(row("201", 4)); // new row on an active tab
      expect((await sync.syncConnection(connId, "cron")).created).toBe(1);
      expect(await counts()).toEqual({ "201": 4, "202": 2, "204": 1 });
      const t = (await leadsLib.trackedTabs(ctx)).find((x) => x.connectionId === connId && x.gid === "202");
      expect(t).toMatchObject({ state: "paused", n: 2 });
      expect(await names(key("202"))).toEqual(["Lead 202-1", "Lead 202-2"]); // still viewable
    });

    it("the Leads filter never changes what is synced", async () => {
      const before = await enabledGids();
      await leadsLib.listLeads(ctx, "all", "", [key("202")]);
      await leadsLib.segCounts(ctx, [key("202")]);
      expect(await enabledGids()).toEqual(before);
    });

    it("selecting it again resumes after confirmation, importing only what is new, with no duplicates", async () => {
      await save.applyTabSelection(ctx, conn(), LIVE, ["201", "202", "204"]);
      expect((await sync.syncConnection(connId, "cron")).created).toBe(0); // waiting for confirmation
      await confirmAll();
      expect((await sync.syncConnection(connId, "cron")).created).toBe(1);
      expect(await counts()).toEqual({ "201": 4, "202": 3, "204": 1 });
      expect((await sync.syncConnection(connId, "cron")).created).toBe(0);
      const ids = (await leads()).map((l) => `${l.sheetGid}:${l.externalId}`);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("regression", () => {
    it("assignments, follow-up dates and statuses survive saving a different selection and syncing", async () => {
      const [lead] = (await leads()).filter((l) => l.name === "Lead 201-1");
      const due = new Date(Date.now() + 5 * 3600e3);
      await db.update(schema.lead).set({ ownerId: ctx.memberId, status: "interested", nextFollowUpAt: due }).where(orm.eq(schema.lead.id, lead.id));
      await save.applyTabSelection(ctx, conn(), LIVE, ["201", "202"]);
      await confirmAll();
      await sync.syncConnection(connId, "cron");
      const [after] = await db.select().from(schema.lead).where(orm.eq(schema.lead.id, lead.id));
      expect(after.ownerId).toBe(ctx.memberId);
      expect(after.status).toBe("interested");
      expect(after.nextFollowUpAt?.getTime()).toBe(due.getTime());
    });

    it("a header row repeated inside the data is not imported as a lead", async () => {
      rows["201"].push(",,id,created_time,campaign_name,platform,full_name,,");
      const before = (await counts())["201"];
      await sync.syncConnection(connId, "cron");
      expect((await counts())["201"]).toBe(before);
      rows["201"].pop();
    });
  });
});
