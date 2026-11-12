import { expect, request as pwRequest, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E } from "../playwright.config";
import { q } from "./db";

const OWNER = { email: E2E.ownerEmail, password: "Owner-pass-12345", name: "Owner" };
const POWER = { email: "power@e2e.test", password: "Power-pass-12345", name: "Power" };
const origin = { origin: E2E.base };
let ipN = 10;
const apiCtx = () => pwRequest.newContext({ baseURL: E2E.base, extraHTTPHeaders: { ...origin, "x-forwarded-for": `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}` } });

test.describe.configure({ mode: "serial" });

let admin: BrowserContext, power: BrowserContext;
let adminPage: Page, powerPage: Page;
const ids: Record<string, string> = {};

async function login(page: Page, u: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Password").fill(u.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
const metric = (page: Page, label: string) => page.locator(".metric", { hasText: label }).locator(".v");
async function newLead(page: Page, name: string, phone: string, source = "Meta Ads") {
  await page.goto("/leads/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Phone or WhatsApp").fill(phone);
  await page.getByLabel("Source").fill(source);
}
async function leadId(name: string) {
  const [r] = await q<{ id: string }>(`select id from lead where name = $1 order by created_at limit 1`, [name]);
  return r.id;
}
async function log(page: Page, channel: string, result: string, notes?: string) {
  await page.getByRole("button", { name: "Log result" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByRole("radio", { name: channel, exact: true }).check();
  await d.getByRole("radio", { name: result, exact: true }).check();
  if (notes) await d.getByLabel("Notes (optional)").fill(notes);
  await d.getByRole("button", { name: "Save result" }).click();
  await expect(d).toBeHidden();
}
const pending = async (leadName: string) =>
  (await q<{ step: string; due_at: Date; attempts: number }>(
    `select t.step, t.due_at, t.attempts from follow_up_task t join lead l on l.id = t.lead_id where l.name = $1 and t.status = 'pending'`, [leadName]))[0];
const leadRow = async (name: string) =>
  (await q<Record<string, any>>(`select * from lead where name = $1 order by created_at limit 1`, [name]))[0];
const tick = (ctx: Awaited<ReturnType<typeof pwRequest.newContext>>, auth = true) =>
  ctx.post("/api/worker/tick", { headers: auth ? { authorization: `Bearer ${E2E.cron}` } : {} });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  admin = await browser.newContext(); power = await browser.newContext();
  adminPage = await admin.newPage(); powerPage = await power.newPage();
});
test.afterAll(async () => { await admin.close(); await power.close(); });

/* ------------------------------------------------------------------ 1. secure bootstrap */
test.describe("first-admin bootstrap", () => {
  test("setup page is reachable only while no workspace exists", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Set up LeadFlow" })).toBeVisible();
  });

  test("registration is refused without the setup token, with a wrong token, or with another email", async () => {
    const api = await apiCtx();
    const body = { email: OWNER.email, password: OWNER.password, name: OWNER.name };
    expect((await api.post("/api/auth/sign-up/email", { data: body })).status()).toBe(403);
    expect((await api.post("/api/auth/sign-up/email", { data: body, headers: { "x-setup-token": "wrong" } })).status()).toBe(403);
    expect((await api.post("/api/auth/sign-up/email", { data: { ...body, email: "intruder@e2e.test" }, headers: { "x-setup-token": E2E.setupToken } })).status()).toBe(403);
    const [{ n }] = await q<{ n: string }>(`select count(*) n from "user"`);
    expect(Number(n)).toBe(0);
    await api.dispose();
  });

  test("concurrent attempts create exactly one admin and one workspace", async () => {
    const attempts = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const api = await apiCtx();
      const r = await api.post("/api/auth/sign-up/email", { data: { email: OWNER.email, password: OWNER.password, name: OWNER.name }, headers: { "x-setup-token": E2E.setupToken } });
      const s = r.status(); await api.dispose(); return s;
    }));
    expect(attempts.filter((s) => s === 200)).toHaveLength(1);
    const [w] = await q<{ n: string }>(`select count(*) n from workspace`);
    const [m] = await q<{ n: string }>(`select count(*) n from workspace_member where role = 'admin'`);
    const [u] = await q<{ n: string }>(`select count(*) n from "user"`);
    expect([Number(w.n), Number(m.n), Number(u.n)]).toEqual([1, 1, 1]);
  });

  test("registration is closed after the workspace exists", async ({ page }) => {
    const api = await apiCtx();
    const r = await api.post("/api/auth/sign-up/email", { data: { email: "late@e2e.test", password: "Late-pass-12345", name: "Late" }, headers: { "x-setup-token": E2E.setupToken } });
    expect(r.status()).toBe(403);
    await api.dispose();
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Setup is closed" })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ 2. auth & session */
test.describe("login, session, logout", () => {
  test("wrong password shows an error", async () => {
    await login(adminPage, { email: OWNER.email, password: "nope-nope-nope" });
    await expect(adminPage.locator("p.err")).toContainText("incorrect");
  });
  test("login, persistence across reload, logout, protected redirect", async () => {
    await login(adminPage, OWNER);
    await expect(adminPage.getByRole("heading", { name: "Good day, Owner" })).toBeVisible();
    await adminPage.reload();
    await expect(adminPage.getByRole("heading", { name: "Good day, Owner" })).toBeVisible();
    await adminPage.getByRole("button", { name: "Sign out" }).click();
    await expect(adminPage).toHaveURL(/\/login/);
    await adminPage.goto("/leads");
    await expect(adminPage).toHaveURL(/\/login/);
    await login(adminPage, OWNER);
    await expect(adminPage.getByRole("heading", { name: "Good day, Owner" })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ 3. leads, duplicates, dashboard */
test.describe("leads", () => {
  test("create leads; phone formatting is preserved, normalized copy is stored", async () => {
    await newLead(adminPage, "Ayesha Khan", "0300-1112233");
    await adminPage.getByRole("button", { name: "Save lead" }).click();
    await expect(adminPage.getByRole("heading", { name: "Ayesha Khan" })).toBeVisible();
    await newLead(adminPage, "Bilal Ahmed", "0311 2223344", "Referral");
    await adminPage.getByRole("button", { name: "Save lead" }).click();
    await expect(adminPage.getByRole("heading", { name: "Bilal Ahmed" })).toBeVisible();
    const a = await leadRow("Ayesha Khan");
    expect(a.phone_raw).toBe("0300-1112233");
    expect(a.phone_norm).toBe("923001112233");
    ids.ayesha = a.id; ids.bilal = (await leadRow("Bilal Ahmed")).id;
  });

  test("duplicate phone (different formatting) warns, links the original, and can be overridden", async () => {
    await newLead(adminPage, "Ayesha K", "+92 300 1112233");
    await adminPage.getByRole("button", { name: "Save lead" }).click();
    await expect(adminPage.locator("p.err")).toContainText("already exists");
    await expect(adminPage.locator("p.err").getByRole("link", { name: "Ayesha Khan" })).toBeVisible();
    expect(await q(`select 1 from lead where name = 'Ayesha K'`)).toHaveLength(0);
    await adminPage.getByLabel("add anyway").check();
    await adminPage.getByRole("button", { name: "Save lead" }).click();
    await expect(adminPage.getByRole("heading", { name: "Ayesha K" })).toBeVisible();
    expect(await q(`select 1 from lead where name = 'Ayesha K'`)).toHaveLength(1);
  });

  test("dashboard numbers equal database counts", async () => {
    await adminPage.goto("/");
    const [r] = await q<{ n: string; u: string }>(`select count(*) n, count(*) filter (where owner_id is null) u from lead`);
    await expect(metric(adminPage, "New today")).toHaveText(r.n);
    await expect(metric(adminPage, "Unassigned")).toHaveText(r.u);
    await expect(metric(adminPage, "Overdue follow-ups")).toHaveText("0");
  });

  test("filters and search", async () => {
    await adminPage.goto("/leads?seg=unassigned");
    await expect(adminPage.locator(".tblwrap tbody tr")).toHaveCount(3);
    await adminPage.goto("/leads?seg=overdue");
    await expect(adminPage.getByText("No leads match these filters.")).toBeVisible();
    await adminPage.goto("/leads?q=bilal");
    await expect(adminPage.locator(".tblwrap tbody tr")).toHaveCount(1);
    await adminPage.goto("/leads?q=1112233");
    await expect(adminPage.locator(".tblwrap tbody tr")).toHaveCount(2);
  });
});

/* ------------------------------------------------------------------ 4. invitations & permissions */
test.describe("invitations and BD permissions", () => {
  let link = "";
  test("admin invites a BD; the link is shown once", async () => {
    await adminPage.goto("/team");
    const form = adminPage.locator("form", { has: adminPage.getByRole("button", { name: "Create invitation" }) });
    await form.getByLabel("Name").fill(POWER.name);
    await form.getByLabel("Email").fill(POWER.email);
    await form.getByRole("button", { name: "Create invitation" }).click();
    link = await adminPage.getByLabel("Invitation link").inputValue();
    expect(link).toContain("/accept?token=");
    const [inv] = await q<{ token_hash: string }>(`select token_hash from invite where email = $1`, [POWER.email]);
    expect(inv.token_hash).toHaveLength(64);
    expect(link).not.toContain(inv.token_hash); // only a hash is stored
  });

  test("invitation only works for the invited email", async () => {
    const token = new URL(link).searchParams.get("token")!;
    const api = await apiCtx();
    const r = await api.post("/api/auth/sign-up/email", { data: { email: "other@e2e.test", password: "Other-pass-12345", name: "Other" }, headers: { "x-invite-token": token } });
    expect(r.status()).toBe(403);
    await api.dispose();
  });

  test("BD accepts the invitation, then the link is dead", async () => {
    await powerPage.goto(link.replace(/^https?:\/\/[^/]+/, E2E.base));
    await powerPage.getByLabel("Password (10+ characters)").fill(POWER.password);
    await powerPage.getByRole("button", { name: "Create account" }).click();
    await expect(powerPage.getByRole("heading", { name: "Good day, Power" })).toBeVisible();
    const [m] = await q<{ role: string }>(`select role from workspace_member where display_name = 'Power'`);
    expect(m.role).toBe("bd");
    const fresh = await (await admin.browser()!.newContext()).newPage();
    await fresh.goto(link.replace(/^https?:\/\/[^/]+/, E2E.base));
    await expect(fresh.getByRole("heading", { name: "Invitation not valid" })).toBeVisible();
    await fresh.context().close();
  });

  test("revoked invitation cannot be used", async () => {
    await adminPage.goto("/team");
    const form = adminPage.locator("form", { has: adminPage.getByRole("button", { name: "Create invitation" }) });
    await form.getByLabel("Name").fill("Revoked Person");
    await form.getByLabel("Email").fill("revoked@e2e.test");
    await form.getByRole("button", { name: "Create invitation" }).click();
    const l2 = (await adminPage.getByLabel("Invitation link").inputValue()).replace(/^https?:\/\/[^/]+/, E2E.base);
    await adminPage.getByRole("button", { name: "Revoke" }).click();
    await expect.poll(async () => (await q(`select 1 from invite where email = 'revoked@e2e.test' and revoked_at is not null`)).length).toBe(1);
    const p = await adminPage.context().newPage();
    await p.goto(l2);
    await expect(p.getByRole("heading", { name: "Invitation not valid" })).toBeVisible();
    await p.close();
  });

  test("BD sees only their own leads and cannot open manager pages", async () => {
    await powerPage.goto("/leads");
    await expect(powerPage.getByText("No leads yet")).toBeVisible();
    await powerPage.goto(`/leads/${ids.bilal}`);
    await expect(powerPage.getByText("This page could not be found")).toBeVisible();
    const r = await powerPage.goto("/team");
    expect(r?.status()).toBe(404);
    await expect(powerPage.getByRole("link", { name: /^Team/ })).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ 5. assignment & follow-up engine */
test.describe("follow-up engine", () => {
  test("manager assigns a lead; the first-contact task is created once", async () => {
    await adminPage.goto(`/leads/${ids.ayesha}`);
    await adminPage.getByLabel("Owner").selectOption({ label: "Power" });
    await adminPage.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    await expect(adminPage.getByRole("dialog")).toBeHidden();
    const t = await pending("Ayesha Khan");
    expect(t.step).toBe("contact_started");
    const [c] = await q<{ n: string }>(`select count(*) n from follow_up_task t join lead l on l.id = t.lead_id where l.name = 'Ayesha Khan'`);
    expect(Number(c.n)).toBe(1);
    await powerPage.goto("/followups?view=mine");
    await expect(powerPage.getByText("Ayesha Khan").first()).toBeVisible();
    await powerPage.goto("/leads");
    await expect(powerPage.locator(".tblwrap tbody tr")).toHaveCount(1);
  });

  test("no answer keeps the lead open and schedules a retry", async () => {
    await powerPage.goto(`/leads/${ids.ayesha}`);
    await log(powerPage, "Call", "No answer");
    const t = await pending("Ayesha Khan");
    expect(t.step).toBe("contact_started");
    expect(t.attempts).toBe(1);
    const mins = (new Date(t.due_at).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(230); expect(mins).toBeLessThan(250); // retry in 4 h
    const l = await leadRow("Ayesha Khan");
    expect(l.closed_at).toBeNull();
    expect(l.first_contacted_at).toBeNull(); // a missed call is not a contact
  });

  test("first contact schedules a follow-up 7 days later; each completed follow-up schedules the next", async () => {
    const week = 7 * 24 * 3600e3;
    await log(powerPage, "WhatsApp", "Spoke to lead", "Wants the card");
    let l = await leadRow("Ayesha Khan");
    const first = new Date(l.first_contacted_at).getTime();
    expect(first).toBeGreaterThan(0);
    let t = await pending("Ayesha Khan");
    expect(t.step).toBe("h24");
    expect(Math.abs(new Date(t.due_at).getTime() - (first + week))).toBeLessThan(60_000);

    // The prominent "Mark Follow-up Done" button completes it and the next one appears without typing a date.
    await powerPage.goto(`/leads/${ids.ayesha}`);
    await expect(powerPage.getByText("Follow-up pending").first()).toBeVisible();
    const before = Date.now();
    await powerPage.getByRole("button", { name: "Mark Follow-up Done" }).click();
    await expect(powerPage.getByText("Follow-up done. The next one is scheduled.")).toBeVisible();
    t = await pending("Ayesha Khan");
    expect(t.step).toBe("h24");
    expect(Math.abs(new Date(t.due_at).getTime() - (before + week))).toBeLessThan(90_000);
    await expect(powerPage.getByText(/Done .* by Power/).first()).toBeVisible();

    await log(powerPage, "Call", "Interested");
    t = await pending("Ayesha Khan");
    expect(t.step).toBe("h24");
    l = await leadRow("Ayesha Khan");
    expect(l.status).toBe("interested");

    const hist = await q<{ step: string; status: string; completed_by: string | null }>(
      `select t.step, t.status, t.completed_by from follow_up_task t join lead l on l.id = t.lead_id where l.name = 'Ayesha Khan' order by t.created_at`);
    expect(hist.map((h) => `${h.step}:${h.status}`)).toEqual(["contact_started:completed", "h24:completed", "h24:completed", "h24:pending"]);
    expect(hist.slice(0, 3).every((h) => !!h.completed_by)).toBe(true); // who completed each one is recorded
  });

  test("overdue stays visible, shows for the owner and the manager, and persists missed history", async () => {
    await q(`update follow_up_task set due_at = now() - interval '3 hours' where status = 'pending' and lead_id = $1`, [ids.ayesha]);
    await q(`update lead set next_follow_up_at = now() - interval '3 hours' where id = $1`, [ids.ayesha]);
    await powerPage.goto("/followups?view=overdue");
    await expect(powerPage.getByText("Ayesha Khan").first()).toBeVisible();
    await expect(powerPage.getByText(/overdue/).first()).toBeVisible();
    await adminPage.goto("/");
    await expect(metric(adminPage, "Overdue follow-ups")).toHaveText("1");
    await adminPage.goto("/team");
    await expect(adminPage.getByRole("heading", { name: "Overdue leads" })).toBeVisible();
    await expect(adminPage.locator(".lead.overdue", { hasText: "Ayesha Khan" })).toContainText("Owner: Power");
  });

  test("worker: unauthorized is rejected; first pass records the miss, notifies and escalates; repeats change nothing", async () => {
    const api = await pwRequest.newContext({ baseURL: E2E.base });
    expect((await tick(api, false)).status()).toBe(401);
    const first = await (await tick(api)).json();
    expect(first.ok).toBe(true);
    // The app also runs a throttled pass when pages load, so this tick may find the work already done.
    // Whichever trigger got there first, the end state must be identical, so assert on the database.

    const snap = async () => ({
      notifs: Number((await q<{ n: string }>(`select count(*) n from notification`))[0].n),
      missedActs: Number((await q<{ n: string }>(`select count(*) n from lead_activity where type = 'followup_missed'`))[0].n),
      escActs: Number((await q<{ n: string }>(`select count(*) n from lead_activity where type = 'escalated'`))[0].n),
    });
    const a = await snap();
    expect(a.missedActs).toBe(1); expect(a.escActs).toBe(1);
    const kinds = (await q<{ kind: string; member: string }>(`select n.kind, m.display_name member from notification n join workspace_member m on m.id = n.member_id order by 1`));
    expect(kinds.filter((k) => k.member === "Power").map((k) => k.kind).sort()).toEqual(["assignment", "due", "overdue"]);
    expect(kinds.filter((k) => k.member === "Owner" && k.kind === "escalation")).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      const again = await (await tick(api)).json();
      expect(again.missed).toBe(0); expect(again.reminders).toBe(0); expect(again.escalated).toBe(0);
    }
    expect(await snap()).toEqual(a); // retried jobs produce no duplicates
    const [t] = await q<{ first_missed_at: Date | null; escalated_at: Date | null }>(`select first_missed_at, escalated_at from follow_up_task where lead_id = $1 and status = 'pending'`, [ids.ayesha]);
    expect(t.first_missed_at).not.toBeNull(); expect(t.escalated_at).not.toBeNull();
    await api.dispose();
  });

  test("alerts page shows the notifications, with external delivery honestly absent", async () => {
    await powerPage.goto("/notifications");
    await expect(powerPage.getByText("Overdue: Ayesha Khan")).toBeVisible();
    await expect(powerPage.getByText("External message")).toHaveCount(0); // none configured, none claimed
    await adminPage.goto("/notifications");
    await expect(adminPage.getByText("Escalation: Ayesha Khan")).toBeVisible();
  });

  test("a completed overdue follow-up schedules the next one, keeps the miss on record, and never drops the lead from the list", async () => {
    await powerPage.goto(`/leads/${ids.ayesha}`);
    await log(powerPage, "Call", "Spoke to lead");
    const t = await pending("Ayesha Khan");
    expect(t).toBeDefined();
    expect((new Date(t.due_at).getTime() - Date.now()) / 86400e3).toBeGreaterThan(6.9);
    const l = await leadRow("Ayesha Khan");
    expect(l.closed_at).toBeNull();
    const [m] = await q<{ n: string }>(`select count(*) n from follow_up_task where lead_id = $1 and first_missed_at is not null`, [ids.ayesha]);
    expect(Number(m.n)).toBe(1); // the miss is still on record
    await powerPage.goto("/followups?view=upcoming");
    await expect(powerPage.getByText("Ayesha Khan").first()).toBeVisible();
    await powerPage.goto("/followups?view=completed");
    await expect(powerPage.getByText("Follow-up").first()).toBeVisible();
  });

  test("reschedule creates a new task and keeps the old one in history", async () => {
    await adminPage.goto(`/leads/${ids.bilal}`);
    await adminPage.getByLabel("Owner").selectOption({ label: "Power" });
    await adminPage.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    await expect(adminPage.getByRole("dialog")).toBeHidden();
    // The date override lives in the Follow-up card: a plain calendar date, read as 10:00 workspace time.
    const picked = new Date(Date.now() + 3 * 86400e3 + 5 * 3600e3).toISOString().slice(0, 10);
    await adminPage.getByLabel("Change the next follow-up date").fill(picked);
    await adminPage.getByRole("button", { name: "Save date" }).click();
    await expect(adminPage.getByText("Next follow-up date saved.")).toBeVisible();
    const h = await q<{ step: string; status: string }>(`select t.step, t.status from follow_up_task t where lead_id = $1 order by created_at`, [ids.bilal]);
    expect(h.map((x) => x.status)).toEqual(["rescheduled", "pending"]);
    const t = await pending("Bilal Ahmed");
    expect((new Date(t.due_at).getTime() - Date.now()) / 3600e3).toBeGreaterThan(48);
    const [src] = await q<{ date_source: string }>(`select date_source from follow_up_task where lead_id = $1 and status = 'pending'`, [ids.bilal]);
    expect(src.date_source).toBe("manual"); // a date a person chose is marked so automation never moves it
  });

  test("close and reopen preserve history", async () => {
    await adminPage.goto(`/leads/${ids.bilal}`);
    await adminPage.getByLabel("Outcome").selectOption("not_interested");
    await adminPage.getByLabel("Reason").fill("Already has a card");
    await adminPage.getByRole("button", { name: "Close lead" }).click();
    await expect(adminPage.getByText("Closed: not interested").first()).toBeVisible();
    expect(await pending("Bilal Ahmed")).toBeUndefined();
    await adminPage.getByRole("button", { name: "Reopen lead" }).click();
    await expect(adminPage.getByText("Lead reopened").first()).toBeVisible();
    expect(await pending("Bilal Ahmed")).toBeDefined();
    const acts = await q<{ type: string }>(`select type from lead_activity where lead_id = $1 order by occurred_at`, [ids.bilal]);
    expect(acts.map((a) => a.type)).toEqual(expect.arrayContaining(["created", "assigned", "followup_rescheduled", "closed", "reopened"]));
  });

  test("lead edits and notes are recorded without overwriting history", async () => {
    await adminPage.goto(`/leads/${ids.bilal}`);
    await adminPage.locator("form", { has: adminPage.getByRole("button", { name: "Save changes" }) }).getByLabel("Campaign").fill("Eid Promo");
    await adminPage.getByRole("button", { name: "Save changes" }).click();
    await expect(adminPage.getByText("Updated campaign").first()).toBeVisible();
    await adminPage.getByLabel("Add a note").fill("Called back on WhatsApp");
    await adminPage.getByRole("button", { name: "Save note" }).click();
    await expect(adminPage.getByText("Called back on WhatsApp").first()).toBeVisible();
    await adminPage.getByRole("button", { name: /^App downloaded/ }).click();
    await expect(adminPage.getByText("App downloaded recorded").first()).toBeVisible();
  });
});

/* ------------------------------------------------------------------ 6. team management */
test.describe("team management", () => {
  test("identity mapping keeps similar names separate and under admin control", async () => {
    await adminPage.goto("/team");
    const f = adminPage.locator("form", { has: adminPage.getByRole("button", { name: "Save mapping" }) });
    await f.getByLabel("Name as in the sheet").fill("Bawar");
    await f.getByLabel("Person").selectOption({ label: "Power" });
    await f.getByRole("button", { name: "Save mapping" }).click();
    await expect(adminPage.getByText("Name mapped.")).toBeVisible();
    await f.getByLabel("Name as in the sheet").fill("Badar");
    await f.getByLabel("Person").selectOption({ label: "Not a team member (unmapped)" });
    await f.getByRole("button", { name: "Save mapping" }).click();
    await expect.poll(async () => (await q(`select alias, member_id from identity_alias order by alias`)).length).toBe(2);
    const rows = await q<{ alias: string; member_id: string | null }>(`select alias, member_id from identity_alias order by alias`);
    expect(rows.find((r) => r.alias === "Bawar")!.member_id).not.toBeNull();
    expect(rows.find((r) => r.alias === "Badar")!.member_id).toBeNull();
  });

  test("deactivating a BD hands over open leads, ends their session and blocks sign-in access", async () => {
    await adminPage.goto("/team");
    const card = adminPage.locator(".lead", { hasText: "Power" }).filter({ has: adminPage.getByRole("button", { name: "Deactivate" }) });
    await card.getByLabel(/Hand Power's open leads to/).selectOption({ label: "Hand leads to Owner" });
    await card.getByRole("button", { name: "Deactivate" }).click();
    await expect.poll(async () => (await q<{ active: boolean }>(`select active from workspace_member where display_name = 'Power'`))[0].active).toBe(false);
    await expect(adminPage.locator(".lead", { hasText: "Power" }).getByText("Deactivated")).toBeVisible(); // card shows the new state
    const owned = await q<{ n: string }>(`select count(*) n from lead l join workspace_member m on m.id = l.owner_id where m.display_name = 'Power' and l.closed_at is null`);
    expect(Number(owned[0].n)).toBe(0);
    const [pend] = await q<{ n: string }>(`select count(*) n from follow_up_task t join workspace_member m on m.id = t.owner_id where m.display_name = 'Power' and t.status = 'pending'`);
    expect(Number(pend.n)).toBe(0);
    await powerPage.goto("/leads");
    await expect(powerPage).toHaveURL(/\/login/); // sessions were revoked
  });

  test("the last admin cannot be demoted", async () => {
    await adminPage.goto("/team");
    const row = adminPage.locator(".lead", { hasText: "Owner" }).first();
    await row.getByLabel("Role for Owner").selectOption("bd");
    await row.getByRole("button", { name: "Set" }).click();
    await expect(adminPage.getByText("There must be at least one admin.")).toBeVisible();
  });
});

/* ------------------------------------------------------------------ 7. settings & error states */
test.describe("settings and errors", () => {
  test("settings validate and apply", async () => {
    await adminPage.goto("/settings");
    await adminPage.getByLabel("First follow-up").fill("60");
    await adminPage.getByRole("button", { name: "Save settings" }).click();
    await expect(adminPage.getByText("Intervals must increase")).toBeVisible();
    await adminPage.getByLabel("First follow-up").fill("12");
    await adminPage.getByRole("button", { name: "Save settings" }).click();
    await expect(adminPage.getByText("Settings saved.")).toBeVisible();
    const [w] = await q<{ s: { h24: number } }>(`select settings s from workspace`);
    expect(w.s.h24).toBe(12);
    await adminPage.getByLabel("First follow-up").fill("24");
    await adminPage.getByRole("button", { name: "Save settings" }).click();
    await expect(adminPage.getByText("Settings saved.")).toBeVisible();
  });
  test("unknown lead and bad ids give a 404, bad invitation a clear message", async () => {
    expect((await adminPage.goto("/leads/00000000-0000-0000-0000-000000000000"))?.status()).toBe(404);
    expect((await adminPage.goto("/leads/not-an-id"))?.status()).toBe(404);
    await adminPage.goto("/accept?token=bogus");
    await expect(adminPage.getByRole("heading", { name: "Invitation not valid" })).toBeVisible();
  });
  test("save admin session for responsive checks", async () => {
    await admin.storageState({ path: "e2e/.admin.json" });
  });
});
