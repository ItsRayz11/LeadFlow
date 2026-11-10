/**
 * Sheet ingestion against the isolated staging database, with Google stubbed out.
 * Run with:  INTEGRATION=1 DATABASE_URL=<staging> npx vitest run src/lib/sheetsync.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const RUN = process.env.INTEGRATION === "1" && !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("ep-long-fire");
const d = RUN ? describe : describe.skip;

const header = "Contacted y,Status,id,created_time,campaign_name,platform,full_name,whatsapp_number,whatsapp_number,Lead Follow Up,Notes,Card Status,onboarded";
// Dates relative to today, so the "recent lead" rule does not make the tests age out.
const today = (() => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; })();
let body: string[] = [];
const csv = () => [header, ...body].join("\n");

d("sheet ingestion (database)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  let sync: typeof import("@/lib/sheetsync");
  let workspaceId: string, memberId: string, memberName: string, connId: string;
  const tag = crypto.randomUUID().slice(0, 6);
  const id = (n: number) => `INT${tag}${n}`;

  beforeAll(async () => {
    ({ db, schema } = await import("@/db"));
    ({ eq } = await import("drizzle-orm"));
    sync = await import("@/lib/sheetsync");
    const [m] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.role, "admin")).limit(1);
    if (!m) throw new Error("Run the e2e suite first so a workspace exists.");
    workspaceId = m.workspaceId; memberId = m.id; memberName = m.displayName;
    const [c] = await db.insert(schema.spreadsheetConnection).values({ workspaceId, spreadsheetId: `INTSHEET${tag}`.padEnd(24, "x"), title: "INT test" }).returning();
    connId = c.id;
    await db.insert(schema.worksheetMapping).values({ connectionId: connId, sheetGid: "1", sheetTitle: "t", enabled: true, confirmedAt: new Date(), columnMap: (await import("@/lib/sheetparse")).DEFAULT_COLUMN_MAP });
    vi.stubGlobal("fetch", async () => new Response(csv(), { status: 200, headers: { "content-type": "text/csv" } }));
  });

  afterAll(async () => {
    if (!RUN) return;
    vi.unstubAllGlobals();
    await db.delete(schema.lead).where(eq(schema.lead.connectionId, connId));
    await db.delete(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connId));
  });

  const leads = () => db.select().from(schema.lead).where(eq(schema.lead.connectionId, connId));

  it("imports new rows once and assigns by owner name", async () => {
    body = [
      `,,${id(1)},11/2/2026,camp,fb,Ann One,ann${tag}@example.com,0300${tag.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`,
      `📄 ${memberName},,${id(2)},${today},camp,ig,Bob Two,,`,
      `Nobody Known,,${id(3)},11/3/2026,camp,ig,Cy Three,,`,
      `,,,,,,,,`,
    ];
    const a = await sync.syncConnection(connId, "manual");
    expect(a.created).toBe(3);
    expect(a.assigned).toBe(1);
    const rows = await leads();
    expect(rows).toHaveLength(3);
    const bob = rows.find((r) => r.externalId === id(2))!;
    expect(bob.ownerId).toBe(memberId);
    const t = await db.select().from(schema.followUpTask).where(eq(schema.followUpTask.leadId, bob.id));
    expect(t).toHaveLength(1);
    const cy = rows.find((r) => r.externalId === id(3))!;
    expect(cy.ownerId).toBeNull();
    const conflicts = await db.select().from(schema.syncConflict).where(eq(schema.syncConflict.connectionId, connId));
    expect(conflicts.map((c) => c.field)).toContain("unmapped_owner");
  });

  it("running again changes nothing (idempotent)", async () => {
    const b = await sync.syncConnection(connId, "cron");
    expect(b.created).toBe(0);
    expect(b.updated).toBe(0);
    expect(await leads()).toHaveLength(3);
  });

  it("two syncs at once never create duplicates", async () => {
    body.push(`,,${id(4)},11/4/2026,camp,fb,Dee Four,,`, `,,${id(5)},11/4/2026,camp,fb,Eve Five,,`);
    await Promise.allSettled([sync.syncConnection(connId, "cron"), sync.syncConnection(connId, "cron")]);
    expect(await leads()).toHaveLength(5);
  });

  it("row order and row numbers do not matter", async () => {
    body.reverse();
    const r = await sync.syncConnection(connId, "cron");
    expect(r.created).toBe(0);
    expect(await leads()).toHaveLength(5);
  });

  it("updates source fields but never CRM-owned fields", async () => {
    const [ann] = (await leads()).filter((l) => l.externalId === id(1));
    await db.update(schema.lead).set({ status: "interested", ownerId: memberId }).where(eq(schema.lead.id, ann.id));
    body = body.map((r) => (r.includes(id(1)) ? r.replace("Ann One", "Ann Renamed") : r));
    const r = await sync.syncConnection(connId, "cron");
    expect(r.updated).toBe(1);
    const [after] = (await leads()).filter((l) => l.externalId === id(1));
    expect(after.name).toBe("Ann Renamed");
    expect(after.status).toBe("interested");
    expect(after.ownerId).toBe(memberId);
  });

  it("a CRM edit is never overwritten by a later sheet edit; it becomes a conflict once", async () => {
    const [ann] = (await leads()).filter((l) => l.externalId === id(1));
    await db.update(schema.lead).set({ name: "Corrected In CRM" }).where(eq(schema.lead.id, ann.id));
    body = body.map((r) => (r.includes(id(1)) ? r.replace("Ann Renamed", "Ann Sheet Edit").replace(",camp,", ",camp2,") : r));
    const r = await sync.syncConnection(connId, "cron");
    expect(r.conflicts).toBe(1);
    const [after] = (await leads()).filter((l) => l.externalId === id(1));
    expect(after.name).toBe("Corrected In CRM");
    expect(after.campaign).toBe("camp2"); // an untouched field still follows the sheet
    const again = await sync.syncConnection(connId, "cron");
    expect(again.conflicts).toBe(0);
  });

  it("a row that disappears from the sheet never deletes the lead", async () => {
    body = body.filter((r) => !r.includes(id(5)));
    await sync.syncConnection(connId, "cron");
    expect(await leads()).toHaveLength(5);
  });

  it("flags a possible duplicate instead of merging", async () => {
    body.push(`,,${id(6)},11/5/2026,camp,fb,Ann Again,ann${tag}@example.com,`);
    const r = await sync.syncConnection(connId, "cron");
    expect(r.possibleDuplicates).toBe(1);
    const dup = (await leads()).find((l) => l.externalId === id(6))!;
    expect((dup.custom as { possibleDuplicateOf?: string }).possibleDuplicateOf).toBeTruthy();
    expect(dup.mergedIntoId).toBeNull();
  });

  it("brings the sheet's existing progress into the CRM", async () => {
    body = [
      `📄 ${memberName},💬 WhatsApp,${id(10)},${today},camp,fb,Dee Ten,,,🔄 48H Follow-up,Called twice,2.🔗 Referral Code Share,FALSE`,
      `📄 ${memberName},❌ Not Interested,${id(11)},${today},camp,fb,Eve Eleven,,,,,,FALSE`,
      `,,${id(12)},${today},camp,fb,Fay Twelve,,,,,,FALSE`,
    ];
    const a = await sync.syncConnection(connId, "manual");
    expect(a.progressed).toBeGreaterThanOrEqual(2);
    const all = await leads();
    const dee = all.find((l) => l.externalId === id(10))!;
    expect(dee.status).toBe("contacted");
    expect(dee.followUpStep).toBe("h48");
    expect(dee.ownerId).toBe(memberId);
    expect(dee.appDownloadedAt).not.toBeNull();
    expect(dee.referralSharedAt).not.toBeNull();
    expect(dee.cardPurchasedAt).toBeNull();
    const tasks = await db.select().from(schema.followUpTask).where(eq(schema.followUpTask.leadId, dee.id));
    expect(tasks.filter((t) => t.status === "pending").map((t) => t.step)).toEqual(["h48"]);
    const acts = await db.select().from(schema.leadActivity).where(eq(schema.leadActivity.leadId, dee.id));
    expect(acts.some((x) => x.type === "note" && x.summary === "Note from the sheet: Called twice")).toBe(true);

    const eve = all.find((l) => l.externalId === id(11))!;
    expect(eve.status).toBe("not_interested");
    expect(eve.closedAt).not.toBeNull();
    expect(eve.followUpStep).toBe("completed");
    const eveTasks = await db.select().from(schema.followUpTask).where(eq(schema.followUpTask.leadId, eve.id));
    expect(eveTasks.filter((t) => t.status === "pending")).toHaveLength(0);

    const fay = all.find((l) => l.externalId === id(12))!;
    expect(fay.status).toBe("new"); // nothing recorded in the sheet: stays new
  });

  it("assigns existing unassigned leads once their owner name is known (backfill)", async () => {
    await db.delete(schema.identityAlias).where(eq(schema.identityAlias.alias, "Someone Else")); // leftover from an earlier run
    // Gus arrives with an unknown owner name, so he is imported unassigned.
    body = [`Someone Else,,${id(13)},${today},camp,fb,Gus Thirteen,,,,,,FALSE`];
    await sync.syncConnection(connId, "manual");
    let gus = (await leads()).find((l) => l.externalId === id(13))!;
    expect(gus.ownerId).toBeNull();
    // The team links that name to a person. The already-imported lead is assigned right away, without waiting for a sheet change.
    const [m] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.id, memberId));
    const ops = await import("@/lib/sheetops");
    const r = await ops.linkAlias(workspaceId, m.userId, "Someone Else", memberId);
    expect(r.assigned).toBeGreaterThanOrEqual(1);
    gus = (await leads()).find((l) => l.externalId === id(13))!;
    expect(gus.ownerId).toBe(memberId);
    // Linking again does not take a lead from someone who has it.
    const again = await ops.linkAlias(workspaceId, m.userId, "Someone Else", memberId);
    expect(again.assigned).toBe(0);
    await db.delete(schema.identityAlias).where(eq(schema.identityAlias.alias, "Someone Else"));
  });

  it("follows later sheet changes while the CRM is untouched, and a CRM edit wins afterwards", async () => {
    const dee = () => leads().then((r) => r.find((l) => l.externalId === id(10))!);
    body = [`📄 ${memberName},⭐ Interested,${id(10)},${today},camp,fb,Dee Ten,,,🕒 24H Follow-up,Called twice,2.🔗 Referral Code Share,FALSE`];
    await sync.syncConnection(connId, "manual");
    let d = await dee();
    expect(d.status).toBe("interested");
    expect(d.followUpStep).toBe("h24");

    // A teammate changes the status in the CRM. From now on the sheet must not override it.
    await db.update(schema.lead).set({ status: "proposal_sent" }).where(eq(schema.lead.id, d.id));
    body = [`📄 ${memberName},✅ Onboarded,${id(10)},${today},camp,fb,Dee Ten,,,⏳ Final Follow-up,Called twice,2.🔗 Referral Code Share,FALSE`];
    await sync.syncConnection(connId, "manual");
    d = await dee();
    expect(d.status).toBe("proposal_sent");
    expect(d.closedAt).toBeNull();
    expect(d.followUpStep).toBe("h24");
  });

  it("an unreadable (private) sheet is reported and marks the connection unhealthy", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await sync.syncConnection(connId, "cron");
    const [c] = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connId));
    expect(c.healthy).toBe(false);
    expect(c.lastError).toMatch(/not readable/);
    vi.stubGlobal("fetch", async () => new Response(csv(), { status: 200, headers: { "content-type": "text/csv" } }));
    await sync.syncConnection(connId, "cron");
    const [ok] = await db.select().from(schema.spreadsheetConnection).where(eq(schema.spreadsheetConnection.id, connId));
    expect(ok.healthy).toBe(true); // recovers on its own
  });
});
