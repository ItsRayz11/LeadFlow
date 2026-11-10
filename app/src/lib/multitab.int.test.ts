/**
 * Several tabs of one spreadsheet, and switching a tab off and on, against the isolated staging database with Google stubbed out.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/multitab.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

const header = "Contacted y,Status,id,created_time,campaign_name,platform,full_name,whatsapp_number,whatsapp_number,Lead Follow Up,Notes,Card Status,onboarded";
const today = (() => { const x = new Date(); return `${x.getMonth() + 1}/${x.getDate()}/${x.getFullYear()}`; })();
const TABS = ["101", "102", "103"] as const;
type Gid = (typeof TABS)[number];
const rowsByTab: Record<Gid, string[]> = { "101": [], "102": [], "103": [] };

d("several tabs and disabling a tab (database)", { timeout: 240_000 }, () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let orm: typeof import("drizzle-orm");
  let sync: typeof import("@/lib/sheetsync");
  let leadsLib: typeof import("@/lib/leads");
  let ctx: import("@/lib/session").Ctx;
  let connId: string;
  const tag = crypto.randomUUID().slice(0, 6);
  const id = (gid: Gid, n: number) => `MT${tag}${gid}x${n}`;
  const row = (gid: Gid, n: number) => `,,${id(gid, n)},${today},camp,fb,Lead ${gid}-${n},,`;

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    orm = await import("drizzle-orm");
    sync = await import("@/lib/sheetsync");
    leadsLib = await import("@/lib/leads");
    const [m] = await db.select().from(schema.workspaceMember).where(orm.eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    const [w] = await db.select().from(schema.workspace).where(orm.eq(schema.workspace.id, m.workspaceId));
    ctx = { userId: m.userId, memberId: m.id, name: m.displayName, role: "admin", workspaceId: m.workspaceId, tz: (w as { timezone?: string }).timezone ?? "Asia/Karachi" };
    const [c] = await db.insert(schema.spreadsheetConnection).values({ workspaceId: m.workspaceId, spreadsheetId: `MTSHEET${tag}`.padEnd(24, "x"), title: "MT test" }).returning();
    connId = c.id;
    const { DEFAULT_COLUMN_MAP } = await import("@/lib/sheetparse");
    for (const g of TABS) {
      // Added unconfirmed, exactly as "Save tabs" leaves them.
      await db.insert(schema.worksheetMapping).values({ connectionId: connId, sheetGid: g, sheetTitle: `Tab ${g}`, enabled: true, columnMap: DEFAULT_COLUMN_MAP });
    }
    rowsByTab["101"] = [row("101", 1), row("101", 2)];
    rowsByTab["102"] = [row("102", 1), row("102", 2), row("102", 3)];
    rowsByTab["103"] = [row("103", 1)];
    vi.stubGlobal("fetch", async (url: string) => {
      const gid = new URL(String(url)).searchParams.get("gid") as Gid;
      return new Response([header, ...(rowsByTab[gid] ?? [])].join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
    });
  });

  afterAll(async () => {
    if (!RUN) return;
    vi.unstubAllGlobals();
    await db.delete(schema.lead).where(orm.eq(schema.lead.connectionId, connId));
    await db.delete(schema.spreadsheetConnection).where(orm.eq(schema.spreadsheetConnection.id, connId));
  });

  const leads = () => db.select().from(schema.lead).where(orm.eq(schema.lead.connectionId, connId));
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const l of await leads()) out[l.sheetGid ?? ""] = (out[l.sheetGid ?? ""] ?? 0) + 1;
    return out;
  };
  const setMap = (gid: Gid, set: Partial<typeof schema.worksheetMapping.$inferInsert>) =>
    db.update(schema.worksheetMapping).set(set).where(orm.and(orm.eq(schema.worksheetMapping.connectionId, connId), orm.eq(schema.worksheetMapping.sheetGid, gid)));
  const confirm = (gid: Gid) => setMap(gid, { confirmedAt: new Date() });

  it("tabs that are not confirmed yet import nothing", async () => {
    const r = await sync.syncConnection(connId, "manual");
    expect(r.ran).toBe(false);
    expect(await leads()).toHaveLength(0);
  });

  it("confirming three tabs imports each tab's rows under that tab", async () => {
    for (const g of TABS) await confirm(g);
    const r = await sync.syncConnection(connId, "manual");
    expect(r.created).toBe(6);
    expect(await counts()).toEqual({ "101": 2, "102": 3, "103": 1 });
    for (const l of await leads()) expect(l.name).toContain(`Lead ${l.sheetGid}-`); // right lead under the right tab
  });

  it("the Leads page filter and its counts follow the tab", async () => {
    const tabs = await leadsLib.trackedTabs(ctx);
    const mine = Object.fromEntries(tabs.filter((t) => t.connectionId === connId).map((t) => [t.gid, t.n]));
    expect(mine).toEqual({ "101": 2, "102": 3, "103": 1 });
    for (const g of TABS) {
      const shown = (await leadsLib.listLeads(ctx, "all", "", `${connId}:${g}`)).filter((l) => l.name.startsWith("Lead "));
      expect(shown).toHaveLength(rowsByTab[g].length);
      expect(shown.every((l) => l.name.startsWith(`Lead ${g}-`))).toBe(true);
      expect((await leadsLib.segCounts(ctx, g)).all).toBeGreaterThanOrEqual(rowsByTab[g].length);
    }
    expect(await leadsLib.listLeads(ctx, "all", "", "not-a-gid")).toEqual(await leadsLib.listLeads(ctx, "all", "", "")); // a bad tab value is ignored
  });

  it("repeated syncs create no duplicates", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await sync.syncConnection(connId, "cron");
      expect(r.created).toBe(0);
    }
    await Promise.allSettled([sync.syncConnection(connId, "cron"), sync.syncConnection(connId, "cron")]);
    expect(await counts()).toEqual({ "101": 2, "102": 3, "103": 1 });
  });

  it("the same id on two tabs stays two separate leads, one per tab", async () => {
    rowsByTab["103"].push(`,,${id("101", 1)},${today},camp,fb,Same id other tab,,`);
    await sync.syncConnection(connId, "cron");
    expect(await counts()).toEqual({ "101": 2, "102": 3, "103": 2 });
    await sync.syncConnection(connId, "cron");
    expect(await counts()).toEqual({ "101": 2, "102": 3, "103": 2 });
    rowsByTab["103"].pop();
  });

  it("disabling a tab keeps its leads and stops syncing it, while other tabs carry on", async () => {
    await setMap("102", { enabled: false, confirmedAt: null }); // exactly what "stop tracking" does
    rowsByTab["102"].push(row("102", 4)); // a new row in the disabled tab
    rowsByTab["101"].push(row("101", 3)); // a new row in an active tab
    rowsByTab["102"][0] = rowsByTab["102"][0].replace("Lead 102-1", "Renamed while off");
    const r = await sync.syncConnection(connId, "cron");
    expect(r.created).toBe(1);
    const c = await counts();
    expect(c["101"]).toBe(3); // active tab picked up its new row
    expect(c["102"]).toBe(3); // disabled tab: nothing lost, nothing added
    expect(c["103"]).toBe(2);
    const off = (await leads()).filter((l) => l.sheetGid === "102");
    expect(off.some((l) => l.name === "Lead 102-1")).toBe(true); // not renamed, not deleted
    const tabs = await leadsLib.trackedTabs(ctx);
    expect(tabs.find((t) => t.gid === "102" && t.connectionId === connId)).toMatchObject({ state: "paused", n: 3 }); // still offered in the Leads filter, marked paused, leads still counted
    expect((await leadsLib.listLeads(ctx, "all", "", "")).filter((l) => l.name.startsWith("Lead 102-")).length).toBe(3);
  });

  it("re-enabling resumes syncing without duplicates, after it is confirmed again", async () => {
    await setMap("102", { enabled: true, confirmedAt: null }); // ticked again: waits for confirmation
    const waiting = await sync.syncConnection(connId, "cron");
    expect(waiting.created).toBe(0);
    expect((await counts())["102"]).toBe(3);
    await confirm("102");
    const r = await sync.syncConnection(connId, "cron");
    expect(r.created).toBe(1); // only the row added while it was off
    expect(await counts()).toEqual({ "101": 3, "102": 4, "103": 2 });
    const again = await sync.syncConnection(connId, "cron");
    expect(again.created).toBe(0);
    const names = (await leads()).filter((l) => l.sheetGid === "102").map((l) => l.externalId);
    expect(new Set(names).size).toBe(names.length);
    expect((await leads()).find((l) => l.externalId === id("102", 1))?.name).toBe("Renamed while off"); // changes made while off arrive now
  });
});
