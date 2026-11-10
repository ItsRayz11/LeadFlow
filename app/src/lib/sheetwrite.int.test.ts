/**
 * Write-back against the isolated staging database, with Google replaced by an in-memory sheet.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/sheetwrite.int.test.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

const HEADER = ["Contacted y", "Status", "Lead Follow Up", "id", "created_time", "campaign_name", "platform", "full_name", "whatsapp_number", "email"];
let grid: string[][] = [];
let writes: { range: string; value: string }[] = [];
let appended: string[][] = [];

const colIndex = (letters: string) => letters.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });

/** A tiny fake of the parts of the Sheets API the app uses. */
async function fakeGoogle(url: string, init?: RequestInit) {
  const u = String(url);
  if (u.includes("oauth2.googleapis.com")) return json({ access_token: "t", expires_in: 3600 });
  if (u.includes("fields=sheets.properties")) return json({ sheets: [{ properties: { sheetId: 5, title: "Leads" } }] });
  if (u.includes("/values:batchUpdate")) {
    const body = JSON.parse(String(init?.body)) as { data: { range: string; values: string[][] }[] };
    for (const x of body.data) {
      const m = x.range.match(/!([A-Z]+)(\d+)$/)!;
      const r = Number(m[2]) - 1, c = colIndex(m[1]);
      while (grid.length <= r) grid.push([]);
      grid[r][c] = x.values[0][0];
      writes.push({ range: x.range, value: x.values[0][0] });
    }
    return json({});
  }
  if (u.includes(":append")) {
    const body = JSON.parse(String(init?.body)) as { values: string[][] };
    for (const row of body.values) { grid.push(row); appended.push(row); }
    return json({});
  }
  if (u.includes("/values/")) return json({ values: grid.map((r) => [...r]) });
  return new Response("not found", { status: 404 });
}

d("write-back (database, fake Google)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  let write: typeof import("@/lib/sheetwrite");
  let ops: typeof import("@/lib/sheetops");
  let workspaceId: string, userId: string, memberId: string, connId: string, mapId: string;
  const tag = crypto.randomUUID().slice(0, 6);
  const rowOf = (id: string) => grid.findIndex((r) => r[3] === id);
  const cell = (id: string, header: string) => grid[rowOf(id)]?.[HEADER.indexOf(header)] ?? "";

  const mkLead = async (id: string, vals: Partial<typeof schema.lead.$inferInsert>, custom: Record<string, unknown>) => {
    const [l] = await db.insert(schema.lead).values({
      workspaceId, name: "Name", acquiredAt: new Date(), connectionId: connId, sheetGid: "5", externalId: id, createdBy: "sheet-sync", ...vals, custom,
    }).returning();
    return l;
  };
  const leadOf = async (id: string) => (await db.select().from(schema.lead).where(eq(schema.lead.id, id)))[0];
  const row = (o: Record<string, string>) => HEADER.map((h) => o[h] ?? "");

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "bot@proj.iam.gserviceaccount.com";
    process.env.GOOGLE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
    ({ db, schema } = await import("@/db"));
    ({ eq } = await import("drizzle-orm"));
    write = await import("@/lib/sheetwrite");
    ops = await import("@/lib/sheetops");
    const [m] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    workspaceId = m.workspaceId; userId = m.userId; memberId = m.id;
    const [c] = await db.insert(schema.spreadsheetConnection).values({ workspaceId, spreadsheetId: `WBSHEET${tag}`.padEnd(24, "x"), title: "WB test", mode: "two_way" }).returning();
    connId = c.id;
    const [mp] = await db.insert(schema.worksheetMapping).values({
      connectionId: connId, sheetGid: "5", sheetTitle: "Leads", enabled: true, confirmedAt: new Date(), valueMaps: { writeProgress: true },
      columnMap: (await import("@/lib/sheetparse")).DEFAULT_COLUMN_MAP,
    }).returning();
    mapId = mp.id;
    vi.stubGlobal("fetch", fakeGoogle);
  });
  afterAll(async () => {
    if (!RUN) return;
    vi.unstubAllGlobals();
    await db.delete(schema.lead).where(eq(schema.lead.connectionId, connId));
    await db.delete(schema.lead).where(eq(schema.lead.createdBy, `wb-${tag}`));
    await db.delete(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connId));
  });

  it("writes a CRM edit to the sheet row found by id, then goes quiet", async () => {
    const id = `WB${tag}1`;
    grid = [HEADER, row({ id, full_name: "Old Name", whatsapp_number: "0300 111", email: "a@x.com" })];
    const l = await mkLead(id, { name: "New Name", phoneRaw: "0300 111", email: "a@x.com" }, { sheetBase: { name: "Old Name", phoneRaw: "0300 111", email: "a@x.com", campaign: null, source: null } });
    writes = [];
    const r = await write.pushConnection(connId);
    expect(r.errors).toEqual([]);
    expect(r.updated).toBe(1);
    expect(cell(id, "full_name")).toBe("New Name");
    expect(writes.map((w) => w.range)).toEqual(["'Leads'!H2"]);
    const after = await leadOf(l.id);
    expect((after.custom as { sheetBase: { name: string } }).sheetBase.name).toBe("New Name");
    writes = [];
    const again = await write.pushConnection(connId);
    expect(again.updated).toBe(0);
    expect(writes).toHaveLength(0); // nothing differs any more: nothing written, and the sheet was not even read
  });

  it("never overwrites a cell the sheet changed too: it records a difference", async () => {
    const id = `WB${tag}2`;
    grid = [HEADER, row({ id, full_name: "Sheet Changed", whatsapp_number: "0300 222" })];
    const l = await mkLead(id, { name: "Crm Changed", phoneRaw: "0300 222" }, { sheetBase: { name: "Original", phoneRaw: "0300 222", email: null, campaign: null, source: null } });
    writes = [];
    await write.pushConnection(connId, { leadId: l.id });
    expect(cell(id, "full_name")).toBe("Sheet Changed");
    expect(writes).toHaveLength(0);
    const open = await db.select().from(schema.syncConflict).where(eq(schema.syncConflict.leadId, l.id));
    expect(open.map((c) => [c.field, c.sheetValue, c.crmValue])).toEqual([["name", "Sheet Changed", "Crm Changed"]]);
  });

  it("writes status and follow-up stage in the sheet's own wording", async () => {
    const id = `WB${tag}3`;
    grid = [HEADER, row({ id, full_name: "Dee", Status: "💬 WhatsApp", "Lead Follow Up": "🕒 24H Follow-up" })];
    const l = await mkLead(id, { name: "Dee", status: "interested", followUpStep: "h48" }, {
      sheetBase: { name: "Dee", phoneRaw: null, email: null, campaign: null, source: null },
      progressBase: { status: "contacted", step: "h24", closed: false }, sheetProgress: { status: "💬 WhatsApp", stage: "🕒 24H Follow-up" },
    });
    writes = [];
    const r = await write.pushConnection(connId, { leadId: l.id });
    expect(r.errors).toEqual([]);
    expect(cell(id, "Status")).toBe("⭐ Interested");
    expect(cell(id, "Lead Follow Up")).toBe("🔄 48H Follow-up");
    const after = await leadOf(l.id);
    const c = after.custom as { progressBase: { status: string; step: string }; sheetProgress: { status: string; stage: string } };
    expect(c.progressBase).toMatchObject({ status: "interested", step: "h48" });
    expect(c.sheetProgress).toEqual({ status: "⭐ Interested", stage: "🔄 48H Follow-up" });
    writes = [];
    await write.pushConnection(connId, { leadId: l.id });
    expect(writes).toHaveLength(0);
  });

  it("a status changed on both sides becomes a difference, and either choice settles it", async () => {
    const id = `WB${tag}4`;
    grid = [HEADER, row({ id, full_name: "Eli", Status: "📵 No Answer", "Lead Follow Up": "🕒 24H Follow-up" })];
    const l = await mkLead(id, { name: "Eli", status: "interested", followUpStep: "h24" }, {
      sheetBase: { name: "Eli", phoneRaw: null, email: null, campaign: null, source: null },
      progressBase: { status: "contacted", step: "h24", closed: false }, sheetProgress: { status: "💬 WhatsApp", stage: "🕒 24H Follow-up" },
    });
    writes = [];
    await write.pushConnection(connId, { leadId: l.id });
    expect(writes).toHaveLength(0);
    expect(cell(id, "Status")).toBe("📵 No Answer"); // not overwritten
    const [diff] = await db.select().from(schema.syncConflict).where(eq(schema.syncConflict.leadId, l.id));
    expect(diff.field).toBe("progress");
    expect(diff.sheetValue).toBe("📵 No Answer | 🕒 24H Follow-up");

    // keep the CRM: the next push writes the CRM's state into the sheet
    await ops.resolveFieldConflict(workspaceId, userId, diff.id, "crm");
    await write.pushConnection(connId, { leadId: l.id });
    expect(cell(id, "Status")).toBe("⭐ Interested");

    // the other lead: take the sheet's value instead
    const id2 = `WB${tag}5`;
    grid.push(row({ id: id2, full_name: "Fay", Status: "❌ Not Interested", "Lead Follow Up": "🔴 Not Interested" }));
    const l2 = await mkLead(id2, { name: "Fay", status: "interested", followUpStep: "h24" }, {
      sheetBase: { name: "Fay", phoneRaw: null, email: null, campaign: null, source: null },
      progressBase: { status: "contacted", step: "h24", closed: false }, sheetProgress: { status: "💬 WhatsApp", stage: "🕒 24H Follow-up" },
    });
    await write.pushConnection(connId, { leadId: l2.id });
    const [diff2] = await db.select().from(schema.syncConflict).where(eq(schema.syncConflict.leadId, l2.id));
    await ops.resolveFieldConflict(workspaceId, userId, diff2.id, "sheet");
    const took = await leadOf(l2.id);
    expect(took.status).toBe("not_interested");
    expect(took.closedAt).not.toBeNull();
    expect(cell(id2, "Status")).toBe("❌ Not Interested"); // and the sheet is left as it was
  });

  it("adds a CRM-created lead as a row once, and links it", async () => {
    grid = [HEADER];
    const [l] = await db.insert(schema.lead).values({
      workspaceId, name: "Hand Made", phoneRaw: "0300 999", source: "Manual", acquiredAt: new Date(), createdBy: `wb-${tag}`,
    }).returning();
    appended = [];
    expect(await write.appendLeadToSheet(l.id)).toBe("added");
    expect(appended).toHaveLength(1);
    const linked = await leadOf(l.id);
    expect(linked.externalId).toMatch(/^crm-/);
    expect(linked.connectionId).toBe(connId);
    expect(appended[0][HEADER.indexOf("full_name")]).toBe("Hand Made");
    expect(appended[0][HEADER.indexOf("id")]).toBe(linked.externalId);
    expect(await write.appendLeadToSheet(l.id)).toBe("none"); // already linked: no second row
    expect(appended).toHaveLength(1);
    void memberId; void mapId;
  });
});
