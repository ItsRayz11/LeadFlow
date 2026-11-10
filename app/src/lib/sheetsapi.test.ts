import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("reading a tab through the Sheets API", () => {
  let api: typeof import("@/lib/sheetsapi");
  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "bot@proj.iam.gserviceaccount.com";
    process.env.GOOGLE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\n"); // how hosts store it
    api = await import("@/lib/sheetsapi");
  });
  afterEach(() => vi.unstubAllGlobals());

  const stub = (formatted: unknown[][], unformatted: unknown[][], calls: string[] = []) =>
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      const u = String(url);
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("oauth2.googleapis.com")) return json({ access_token: "t", expires_in: 3600 });
      if (u.includes("fields=sheets.properties")) return json({ sheets: [{ properties: { sheetId: 7, title: "Leads" } }] });
      if (u.includes("UNFORMATTED_VALUE")) return json({ values: unformatted });
      return json({ values: formatted });
    });

  it("is configured when both values are present, and accepts the one-line key form", () => {
    expect(api.serviceAccountConfigured()).toBe(true);
  });

  it("restores long ids that the sheet displays in scientific notation", async () => {
    const calls: string[] = [];
    stub([["id", "name"], ["2.56708E+15", "Ann"], ["2567082097146954", "Bo"]], [["id", "name"], [2567082097146950, "Ann"], ["2567082097146954", "Bo"]], calls);
    const t = await api.readTableApi("SHEETID", "7");
    expect(t[1][0]).toBe("2567082097146950");
    expect(t[2][0]).toBe("2567082097146954");
    expect(calls.some((c) => c.includes("UNFORMATTED_VALUE"))).toBe(true);
  });

  it("does not read twice when nothing is in scientific notation", async () => {
    const calls: string[] = [];
    stub([["id"], ["123"]], [], calls);
    await api.readTableApi("SHEETID2", "7");
    expect(calls.some((c) => c.includes("UNFORMATTED_VALUE"))).toBe(false);
  });

  it("leaves numbers too large to hold exactly alone instead of guessing digits", async () => {
    stub([["id"], ["1.23457E+17"]], [["id"], [123456789012345680]]);
    const t = await api.readTableApi("SHEETID3", "7");
    expect(t[1][0]).toBe("1.23457E+17");
  });
});
