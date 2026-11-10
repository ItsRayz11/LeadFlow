import { expect, request as pwRequest, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { E2E } from "../playwright.config";

mkdirSync("e2e/screens", { recursive: true });
test.describe.configure({ mode: "serial" });
test.describe.configure({ retries: 2 }); // pages are rendered against a staging database reached over a slow link; a dropped request must not fail the run

const OWNER = { email: E2E.ownerEmail, password: "Owner-pass-12345", name: "Owner" };
let ctx: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // Self-contained: create the first admin if this run starts from an empty database, then sign in through the real form.
  // Retried, because the staging database is reached over a slow link and a single dropped request must not fail the whole file.
  ctx = await browser.newContext();
  page = await ctx.newPage();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const api = await pwRequest.newContext({ baseURL: E2E.base, extraHTTPHeaders: { origin: E2E.base, "x-forwarded-for": `10.9.9.${attempt}` } });
    const su = await api.post("/api/auth/sign-up/email", { data: { email: OWNER.email, password: OWNER.password, name: OWNER.name }, headers: { "x-setup-token": E2E.setupToken } });
    void su;
    await api.dispose();
    await page.goto("/login");
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const ok = await page.getByRole("heading", { name: "Good day, Owner" }).waitFor({ state: "visible", timeout: 25_000 }).then(() => true, () => false);
    if (ok) return;
    await page.waitForTimeout(11_000); // the login limiter allows a few tries per 10 seconds: wait it out instead of tripping it
  }
  throw new Error("Could not sign in as the first admin after 4 attempts");
});
test.afterAll(async () => { await ctx.close(); });

const noOverflow = async () => {
  await page.waitForLoadState("networkidle");
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(o.sw, `scrollWidth ${o.sw} > clientWidth ${o.cw}`).toBeLessThanOrEqual(o.cw + 1);
};

test("Insights shows where leads stand, with every number linking to its leads", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/insights");
  await expect(page.getByRole("heading", { name: "Where your leads stand" })).toBeVisible();
  for (const label of ["Interested right now", "Converted", "Dropped after showing interest", "Lost in total"]) {
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  }
  await expect(page.getByText("Open leads by follow-up stage")).toBeVisible();
  await expect(page.getByText("Why leads were lost")).toBeVisible();
  await page.screenshot({ path: "e2e/screens/insights-pipeline.png", fullPage: true });
});

test("the new lead views open without error", async () => {
  for (const seg of ["interested", "converted", "lost", "lost_interested"]) {
    await page.goto(`/leads?seg=${seg}`);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  }
  await page.goto("/leads");
  await expect(page.getByRole("link", { name: /Dropped after interest/ })).toBeVisible();
});

test("Integrations has the Start here checklist and the tab picker", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/integrations");
  await expect(page.getByRole("heading", { name: /Start here/ })).toBeVisible();
  await expect(page.getByText("Choose the tab you work in")).toBeVisible();
  await expect(page.getByText("Turn on two-way sync").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose tabs to track" })).toBeVisible();
  await expect(page.getByText("Do this next")).toHaveCount(1); // exactly one step is highlighted
  await page.screenshot({ path: "e2e/screens/integrations-start-here.png", fullPage: true });
});

test("the tab picker rejects a link that is not a Google Sheet", async () => {
  await page.goto("/integrations?sheet=" + encodeURIComponent("https://example.com/not-a-sheet"));
  await expect(page.getByRole("alert").filter({ hasText: "Google Sheets link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Track the ticked tabs" })).toHaveCount(0);
});

test("the webhook refuses callers without the secret", async () => {
  const api = await pwRequest.newContext({ baseURL: E2E.base });
  const r = await api.post("/api/sheet/webhook", { data: { spreadsheetId: "x".repeat(30) } });
  expect(r.status()).toBe(401);
  await api.dispose();
});

for (const route of ["/", "/insights", "/integrations", "/leads?seg=lost_interested"]) {
  test(`phone width: ${route} has no horizontal overflow`, async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    await noOverflow();
    if (route === "/insights" || route === "/integrations") await page.screenshot({ path: `e2e/screens/390-${route.replace(/\W+/g, "_")}.png`, fullPage: true });
  });
}
