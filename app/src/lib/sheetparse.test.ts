import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_COLUMN_MAP, cleanAlias, parseCsv, parseSheetUrl, parseWorksheet } from "./sheetparse";

const TZ = "Asia/Karachi";
const csv = [
  "Contacted y,Status,id,created_time,campaign_name,platform,full_name,whatsapp_number,whatsapp_number",
  ",,111,11/2/2026,camp A,fb,Ayesha Khan,ayesha@example.com,923001234567",
  "📄 Fazal,⭐ Interested,222,11/3/2026,camp A,ig,\"Bilal, Jr\",0300 7654321,",
  ",,,,,,,,",
  ",,333,11/3/2026,camp B,fb,,0300000000,",
  ",,111,11/2/2026,camp A,fb,Dup Row,0300111222,",
  ",,444,,camp B,fb,No Contact,,",
].join("\n");

describe("csv", () => {
  it("handles quotes, commas and embedded newlines", () => {
    expect(parseCsv('a,"b,c","d\ne"\n1,2,3')).toEqual([["a", "b,c", "d\ne"], ["1", "2", "3"]]);
    expect(parseCsv('a,"say ""hi"""\r\nx,y')).toEqual([["a", 'say "hi"'], ["x", "y"]]);
  });
});

describe("sheet url", () => {
  it("extracts the spreadsheet id and gid", () => {
    const u = "https://docs.google.com/spreadsheets/d/1l4jCxAY_vZXdb-MejHX2dc-VfOHp2906LuaX45NV6Kw/edit?gid=1316863377#gid=1316863377";
    expect(parseSheetUrl(u)).toEqual({ spreadsheetId: "1l4jCxAY_vZXdb-MejHX2dc-VfOHp2906LuaX45NV6Kw", gid: "1316863377" });
    expect(parseSheetUrl("https://evil.example/spreadsheets/d/abc")).toBeNull();
  });
  it("cleans owner names", () => expect(cleanAlias("📄 Fazal")).toBe("Fazal"));
});

describe("worksheet parsing", () => {
  const r = parseWorksheet(parseCsv(csv), DEFAULT_COLUMN_MAP, TZ, fromZonedTime);
  it("keeps valid rows keyed by the persistent id, not the row number", () => {
    expect(r.rows.map((x) => x.externalId)).toEqual(["111", "222", "444"]);
  });
  it("finds the email and phone even when columns are misaligned or duplicated", () => {
    expect(r.rows[0].email).toBe("ayesha@example.com");
    expect(r.rows[0].phoneNorm).toBe("923001234567");
    expect(r.rows[1].phoneNorm).toBe("923007654321");
  });
  it("reads the owner alias and keeps the sheet status for display", () => {
    expect(r.rows[1].ownerAlias).toBe("Fazal");
    expect(r.rows[1].sheetStatus).toContain("Interested");
  });
  it("reports skipped rows and ignores blank filler rows", () => {
    expect(r.skipped).toEqual(expect.arrayContaining([{ reason: "no name", count: 1 }, { reason: "repeated lead id", count: 1 }]));
  });
  it("interprets dates in the workspace time zone", () => {
    expect(r.rows[0].acquiredAt?.toISOString()).toBe("2026-11-02T07:00:00.000Z"); // noon PKT
    expect(r.rows[2].acquiredAt).toBeNull();
  });
  it("names missing columns instead of importing garbage", () => {
    const bad = parseWorksheet(parseCsv("a,b\n1,2"), DEFAULT_COLUMN_MAP, TZ, fromZonedTime);
    expect(bad.rows).toHaveLength(0);
    expect(bad.missingColumns.length).toBeGreaterThan(0);
  });
});
