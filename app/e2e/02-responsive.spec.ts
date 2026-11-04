import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { q } from "./db";

test.use({ storageState: "e2e/.admin.json" });
mkdirSync("e2e/screens", { recursive: true });

const WIDTHS = [360, 390, 768, 1024, 1440];
const ROUTES = ["/", "/leads", "/followups?view=team", "/team", "/settings", "/notifications", "/leads/new"];

for (const w of WIDTHS) {
  test.describe(`${w}px`, () => {
    test.use({ viewport: { width: w, height: 844 } });

    for (const route of ROUTES) {
      test(`${route} has no horizontal overflow`, async ({ page }) => {
        await page.goto(route);
        await expect(page.locator("main")).toBeVisible(); // fails if the session was lost and we landed on /login
        await page.waitForLoadState("networkidle");
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(o.sw, `scrollWidth ${o.sw} > clientWidth ${o.cw}`).toBeLessThanOrEqual(o.cw + 1);
        if (route === "/" || route === "/followups?view=team") await page.screenshot({ path: `e2e/screens/${w}-${route.replace(/\W+/g, "_")}.png`, fullPage: true });
      });
    }

    test("navigation matches the breakpoint", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("main")).toBeVisible();
      if (w < 980) {
        await expect(page.locator("nav.tabbar")).toBeVisible();
        await expect(page.locator("nav.side")).toBeHidden();
      } else {
        await expect(page.locator("nav.side")).toBeVisible();
        await expect(page.locator("nav.tabbar")).toBeHidden();
      }
    });

    test("lead list uses cards on phones and a table on larger screens", async ({ page }) => {
      await page.goto("/leads");
      await expect(page.locator("main")).toBeVisible();
      if (w < 700) {
        await expect(page.locator(".cards.m")).toBeVisible();
        await expect(page.locator(".tbl")).toBeHidden();
      } else {
        await expect(page.locator(".tbl table")).toBeVisible();
        await expect(page.locator(".cards.m")).toBeHidden();
      }
    });

    test("touch targets on the lead page are at least 44px", async ({ page }) => {
      const [{ id }] = await q<{ id: string }>(`select id from lead where name = 'Ayesha Khan' limit 1`);
      await page.goto(`/leads/${id}`);
      await expect(page.locator("main button").first()).toBeVisible();
      const small = await page.evaluate(() => {
        const bad: string[] = [];
        document.querySelectorAll<HTMLElement>("main button, main a.chip, main select, main input:not([type=hidden]):not([type=checkbox])").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.height < 40) bad.push(`${el.tagName} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" ${Math.round(r.height)}px`);
        });
        return bad;
      });
      expect(small).toEqual([]);
    });
  });
}
