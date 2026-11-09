/**
 * Alias linking, conflict settling and mapping edits against the isolated staging database, with Google stubbed out.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/sheetops.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

const header = "Contacted y,Status,id,created_time,campaign_name,platform,full_name,whatsapp_number,whatsapp_number";
let body: string[] = [];
const csv = () => [header, ...body].join("\n");

d("sheet operator actions (database)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  let sync: typeof import("@/lib/sheetsync");
  let ops: typeof import("@/lib/sheetops");
  let workspaceId: string, userId: string, memberId: string, connId: string, mapId: string;
  const tag = crypto.randomUUID().slice(0, 6);
  const aliasName = `Zed${[...tag].map((ch) => "abcdefghij"[parseInt(ch, 16) % 10]).join("")}`; // letters only: the sheet reader strips digits from names
  const leadId = `OPS${tag}1`;

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    ({ eq } = await import("drizzle-orm"));
    sync = await import("@/lib/sheetsync");
    ops = await import("@/lib/sheetops");
    const [m] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    workspaceId = m.workspaceId; userId = m.userId; memberId = m.id;
    const [c] = await db.insert(schema.spreadsheetConnection).values({ workspaceId, spreadsheetId: `OPSSHEET${tag}`.padEnd(24, "x"), title: "OPS test" }).returning();
    connId = c.id;
    const [mp] = await db.insert(schema.worksheetMapping).values({ connectionId: connId, sheetGid: "1", sheetTitle: "t", enabled: true, confirmedAt: new Date(), columnMap: (await import("@/lib/sheetparse")).DEFAULT_COLUMN_MAP }).returning();
    mapId = mp.id;
    vi.stubGlobal("fetch", async () => new Response(csv(), { status: 200, headers: { "content-type": "text/csv" } }));
  });
  afterAll(async () => {
    if (!RUN) return;
    vi.unstubAllGlobals();
    await db.delete(schema.lead).where(eq(schema.lead.connectionId, connId));
    await db.delete(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connId));
    const { sql } = await import("drizzle-orm");
    await db.delete(schema.identityAlias).where(sql`lower(${schema.identityAlias.alias}) = lower(${aliasName})`);
  });

  const theLead = async () => (await db.select().from(schema.lead).where(eq(schema.lead.connectionId, connId)))[0];
  const openConflicts = async (field?: string) =>
    (await db.select().from(schema.syncConflict).where(eq(schema.syncConflict.connectionId, connId))).filter((x) => !x.resolvedAt && (!field || x.field === field));

  it("linking a name resolves its notices, and linking again updates instead of ignoring", async () => {
    body = [`${aliasName},,${leadId},11/2/2026,camp,fb,Ann,,0300111${tag.replace(/\D/g, "").padEnd(4, "1").slice(0, 4)}`];
    await sync.syncConnection(connId, "cron");
    expect((await openConflicts("unmapped_owner")).length).toBe(1);
    await ops.linkAlias(workspaceId, userId, aliasName.toUpperCase(), memberId);
    expect((await openConflicts("unmapped_owner")).length).toBe(0);
    await ops.linkAlias(workspaceId, userId, aliasName, memberId); // second time: no duplicate alias row, no error
    const rows = await db.select().from(schema.identityAlias).where(eq(schema.identityAlias.workspaceId, workspaceId));
    expect(rows.filter((r) => r.alias.toLowerCase() === aliasName.toLowerCase())).toHaveLength(1);
  });

  it("refuses to link an inactive or unknown member", async () => {
    await expect(ops.linkAlias(workspaceId, userId, "Nobody", crypto.randomUUID())).rejects.toThrow(/not active/);
  });

  it("a CRM edit followed by a sheet edit can be settled either way", async () => {
    const l = await theLead();
    await db.update(schema.lead).set({ name: "Typed By Team" }).where(eq(schema.lead.id, l.id));
    body = [body[0].replace("Ann", "Ann From Sheet")];
    await sync.syncConnection(connId, "cron");
    const [c1] = await openConflicts("name");
    expect(c1.crmValue).toBe("Typed By Team");
    await ops.resolveFieldConflict(workspaceId, userId, c1.id, "sheet");
    expect((await theLead()).name).toBe("Ann From Sheet");
    expect((await openConflicts("name")).length).toBe(0);
    await expect(ops.resolveFieldConflict(workspaceId, userId, c1.id, "sheet")).rejects.toThrow(/already settled/);

    await db.update(schema.lead).set({ name: "Typed Again" }).where(eq(schema.lead.id, l.id));
    body = [body[0].replace("Ann From Sheet", "Ann Third")];
    await sync.syncConnection(connId, "cron");
    const [c2] = await openConflicts("name");
    await ops.resolveFieldConflict(workspaceId, userId, c2.id, "crm");
    expect((await theLead()).name).toBe("Typed Again");
    const acts = await db.select().from(schema.leadActivity).where(eq(schema.leadActivity.leadId, l.id));
    expect(acts.some((a) => a.type === "edited")).toBe(true);
  });

  it("a mapping edit is validated, resets confirmation, and cannot change the id column after import", async () => {
    const base = (await import("@/lib/sheetparse")).DEFAULT_COLUMN_MAP;
    await expect(ops.saveMapping(workspaceId, userId, mapId, { ...base, campaign: "no_such_column" })).rejects.toThrow(/not in row/);
    await ops.saveMapping(workspaceId, userId, mapId, { ...base, campaign: "platform" });
    const [m] = await db.select().from(schema.worksheetMapping).where(eq(schema.worksheetMapping.id, mapId));
    expect(m.confirmedAt).toBeNull();
    expect((m.columnMap as { campaign?: string }).campaign).toBe("platform");
    await expect(ops.saveMapping(workspaceId, userId, mapId, { ...base, externalId: "campaign_name" })).rejects.toThrow(/duplicate them|locked/);
  });

  it("preview reports rows, skipped counts and samples without importing", async () => {
    const before = (await db.select().from(schema.lead).where(eq(schema.lead.connectionId, connId))).length;
    const pv = await ops.previewWorksheet(`OPSSHEET${tag}`.padEnd(24, "x"), "1", (await import("@/lib/sheetparse")).DEFAULT_COLUMN_MAP, 1, "Asia/Karachi");
    expect(pv.valid).toBe(1);
    expect(pv.sample[0].externalId).toBe(leadId);
    expect(pv.headers).toContain("full_name");
    expect((await db.select().from(schema.lead).where(eq(schema.lead.connectionId, connId))).length).toBe(before);
  });
});
