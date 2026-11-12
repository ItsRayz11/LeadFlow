import { expect, request as pwRequest, test } from "@playwright/test";
import { E2E } from "../playwright.config";

/** Works alone or after the main suite: registers the owner if needed, then checks the pop-up. Run: npx playwright test e2e/04-popup.spec.ts */
const OWNER = { email: E2E.ownerEmail, password: "Owner-pass-12345", name: "Owner" };

test("a lead opens in a pop-up over the list, edits save in place, and the full-page choice is respected", async ({ page, browser }) => {
  const api = await pwRequest.newContext({ baseURL: E2E.base, extraHTTPHeaders: { origin: E2E.base, "x-forwarded-for": "10.9.0.1" } });
  const r = await api.post("/api/auth/sign-up/email", { data: { email: OWNER.email, password: OWNER.password, name: OWNER.name }, headers: { "x-setup-token": E2E.setupToken } });
  // 403: the main suite already registered this owner; 422: the owner already exists in a reused database.
  // Sign-in below fails if the owner is genuinely missing.
  expect([200, 403, 422]).toContain(r.status());
  await api.dispose();

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Good day, Owner" })).toBeVisible();

  await page.goto("/leads/new");
  await page.getByLabel("Name").fill("Popup Person");
  await page.getByLabel("Phone or WhatsApp").fill("0300-5554433");
  await page.getByLabel("Source").fill("Test");
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByRole("heading", { name: "Popup Person" })).toBeVisible();

  // Default: a pop-up over the list; the list stays underneath.
  await page.goto("/leads");
  await page.getByRole("link", { name: /Popup Person/ }).first().click();
  const dlg = page.getByRole("dialog", { name: "Lead details" });
  await expect(dlg).toBeVisible();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  await expect(dlg.getByRole("heading", { name: "Popup Person" })).toBeVisible();

  // Saving a change keeps the pop-up open and updates it.
  await dlg.getByLabel("Name").fill("Popup Renamed");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(dlg.getByRole("heading", { name: "Popup Renamed" })).toBeVisible();

  // Escape closes it and returns to the list, which shows the new name.
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(page).toHaveURL(/\/leads$/);
  await expect(page.getByRole("link", { name: /Popup Renamed/ }).first()).toBeVisible();

  // Reloading a lead's address shows the full page, not a pop-up.
  await page.getByRole("link", { name: /Popup Renamed/ }).first().click();
  await expect(dlg).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Lead details" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Popup Renamed" })).toBeVisible();

  // The "new lead" page is not mistaken for a lead.
  await page.goto("/leads");
  await page.getByRole("link", { name: "Add lead" }).click();
  await expect(page.getByRole("button", { name: "Save lead" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Lead details" })).toHaveCount(0);

  // Choosing "Full page" makes the same click land on its own page.
  await page.goto("/leads");
  await page.getByRole("button", { name: "Full page" }).click();
  await page.getByRole("link", { name: /Popup Renamed/ }).first().click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("dialog", { name: "Lead details" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to leads" })).toBeVisible();
  void browser;
});
