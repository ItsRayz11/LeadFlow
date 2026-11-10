import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMN_MAP } from "@/lib/sheetparse";
import { buildNewRow, indexRows, planLeadWrites, type Values } from "@/lib/sheetplan";
import { buildAssertion, colLetter } from "@/lib/sheetsapi";

const headers = ["Contacted y", "Status", "id", "created_time", "campaign_name", "platform", "full_name", "whatsapp_number", "whatsapp_number", "email"];
const row = (o: Record<string, string>) => headers.map((h) => o[h] ?? "");
const v = (o: Partial<Values>): Values => ({ name: "Asha", phoneRaw: "+971 50 111 2222", email: "asha@x.com", campaign: "Summer", source: "fb", ...o });
const sheet = (cells: Record<string, string>) => [headers, row({ id: "L1", full_name: "Asha", whatsapp_number: "+971 50 111 2222", email: "asha@x.com", campaign_name: "Summer", platform: "fb", ...cells })];
const plan = (table: string[][], base: Values, crm: Values, open: string[] = []) =>
  planLeadWrites({ table, headerRow: 0, rowNumber: 2, map: DEFAULT_COLUMN_MAP, base, crm, openConflicts: new Set(open) });

describe("write-back rules", () => {
  it("writes a CRM edit when the sheet still has the old value", () => {
    const p = plan(sheet({}), v({}), v({ name: "Asha K" }));
    expect(p).toEqual([{ kind: "write", field: "name", col: 7, value: "Asha K" }]);
  });

  it("does nothing when nothing differs", () => {
    expect(plan(sheet({}), v({}), v({}))).toEqual([]);
  });

  it("records a difference instead of overwriting when both sides changed", () => {
    const p = plan(sheet({ full_name: "Asha Sheet" }), v({}), v({ name: "Asha CRM" }));
    expect(p).toEqual([{ kind: "conflict", field: "name", sheetValue: "Asha Sheet", crmValue: "Asha CRM" }]);
  });

  it("just moves the baseline when the sheet already holds the CRM value", () => {
    expect(plan(sheet({ full_name: "Asha K" }), v({}), v({ name: "Asha K" }))).toEqual([{ kind: "adopt", field: "name" }]);
  });

  it("leaves a field alone while an older difference on it is still open", () => {
    const p = plan(sheet({}), v({}), v({ name: "New" }), ["name"]);
    expect(p).toEqual([{ kind: "skip", field: "name", reason: "an open difference must be settled first" }]);
  });

  it("finds the phone column by its old value, even with duplicate headers", () => {
    const t = sheet({ whatsapp_number: "", email: "asha@x.com" });
    t[1][8] = "+971 50 111 2222"; // the phone sits in the second whatsapp_number column
    expect(plan(t, v({}), v({ phoneRaw: "+971 50 999 0000" }))).toEqual([{ kind: "write", field: "phoneRaw", col: 9, value: "+971 50 999 0000" }]);
  });

  it("never writes a phone into the email column, or an email into a phone column", () => {
    const p = plan(sheet({}), v({}), v({ email: "new@x.com", phoneRaw: "0501234567" }));
    expect(p).toContainEqual({ kind: "write", field: "email", col: 10, value: "new@x.com" });
    expect(p).toContainEqual({ kind: "write", field: "phoneRaw", col: 8, value: "0501234567" });
  });

  it("clears a cell when the CRM value was removed", () => {
    expect(plan(sheet({}), v({}), v({ campaign: null }))).toEqual([{ kind: "write", field: "campaign", col: 5, value: "" }]);
  });

  it("skips a field whose column is not in the sheet", () => {
    const map = { ...DEFAULT_COLUMN_MAP, campaign: undefined };
    const p = planLeadWrites({ table: sheet({}), headerRow: 0, rowNumber: 2, map, base: v({}), crm: v({ campaign: "X" }), openConflicts: new Set() });
    expect(p).toEqual([{ kind: "skip", field: "campaign", reason: "no matching column in the sheet" }]);
  });

  it("ignores whitespace-only differences", () => {
    expect(plan(sheet({}), v({}), v({ name: " Asha " }))).toEqual([]);
  });
});

describe("row lookup", () => {
  it("maps ids to row numbers by id, never by position", () => {
    const t = [headers, row({ id: "A" }), row({}), row({ id: "B" }), row({ id: "A" })];
    const m = indexRows(t, 0, [2]);
    expect(m.get("A")).toBe(2);
    expect(m.get("B")).toBe(4);
    expect(m.size).toBe(2);
  });
});

describe("new row layout", () => {
  it("follows the sheet's own column order and leaves unknown columns empty", () => {
    const r = buildNewRow(headers, DEFAULT_COLUMN_MAP, { externalId: "crm-1", name: "Bo", phone: "050", email: "b@x.com", campaign: "C", source: "S", created: "2026-11-10 09:00" });
    expect(r).toEqual(["", "", "crm-1", "2026-11-10 09:00", "C", "S", "Bo", "050", "", "b@x.com"]);
  });
  it("refuses when the id or name column is missing", () => {
    expect(buildNewRow(["a", "b"], DEFAULT_COLUMN_MAP, { externalId: "x", name: "y", phone: null, email: null, campaign: null, source: null, created: "" })).toBeNull();
  });
});

describe("google sign-in", () => {
  it("builds a verifiable RS256 assertion for the service account", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = buildAssertion("bot@proj.iam.gserviceaccount.com", pem, 1_700_000_000);
    const [h, b, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(b, "base64url").toString());
    expect(claims).toMatchObject({ iss: "bot@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/spreadsheets", iat: 1_700_000_000, exp: 1_700_003_600 });
    const ok = createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
  it("names columns like a spreadsheet", () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(colLetter)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });
});
