import { expect, test } from "@playwright/test";
import { E2E } from "../playwright.config";
import { q } from "./db";

/**
 * Interrupted first-admin registration: the owner's user exists but the workspace was never created.
 * Runs last because it removes the workspace. The suite's global setup resets the database on the next run.
 */
const OWNER = { email: E2E.ownerEmail, password: "Owner-pass-12345" };

test("owner can finish an interrupted setup with the setup token", async ({ page }) => {
  // Simulate the interruption: user and session survive, the workspace (and its member row) are gone.
  await q(`DELETE FROM workspace`);
  expect(Number((await q<{ n: string }>(`select count(*) n from workspace`))[0].n)).toBe(0);
  expect(Number((await q<{ n: string }>(`select count(*) n from "user" where email = $1`, [OWNER.email]))[0].n)).toBe(1);

  // Registration again is refused because the email already exists, and the page points to the recovery path.
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Set up LeadFlow" })).toBeVisible();
  await page.getByLabel("Your name").fill("Owner");
  await page.getByLabel("Owner email").fill(OWNER.email);
  await page.getByLabel("Password (10+ characters)").fill(OWNER.password);
  await page.getByLabel("Setup token").fill(E2E.setupToken);
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.locator("p.err")).toContainText("open /setup again to finish");

  // The owner signs in, is sent to /setup, a wrong token fails, the right token restores the workspace.
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/setup/);
  await expect(page.getByRole("heading", { name: "Finish setup" })).toBeVisible();
  await page.getByLabel("Setup token").fill("wrong-token");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.locator("p.err")).toContainText("could not be completed");
  expect(Number((await q<{ n: string }>(`select count(*) n from workspace`))[0].n)).toBe(0);

  await page.getByLabel("Setup token").fill(E2E.setupToken);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Good day, Owner" })).toBeVisible();
  const [w] = await q<{ n: string }>(`select count(*) n from workspace`);
  const [m] = await q<{ n: string }>(`select count(*) n from workspace_member where role = 'admin'`);
  expect([Number(w.n), Number(m.n)]).toEqual([1, 1]);
  const [a] = await q<{ n: string }>(`select count(*) n from audit_log where action = 'setup.recovered'`);
  expect(Number(a.n)).toBe(1);

  // Once done, the recovery path is closed.
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Setup is closed" })).toBeVisible();
});
