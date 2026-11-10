import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_COLUMN_MAP, cleanAlias, parseCsv, parseSheetDate, parseSheetUrl, parseTabList, parseWorksheet } from "./sheetparse";

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

describe("tab list", () => {
  const html = String.raw`<script>items.push({name: "Class Data", pageUrl: "https:\/\/docs.google.com\/spreadsheets\/d\/ABC\/htmlview\/sheet?headers\x3dtrue&gid=0", gid: "0",initialSheet: ("0" == gid)});
items.push({name: "Leads \x26 \"Ads\"", pageUrl: "https:\/\/x\/y?gid\x3d123", gid: "123",initialSheet: false});
items.push({name: "Class Data", pageUrl: "https:\/\/x", gid: "0"});</script>`;
  it("reads names and ids, decodes escapes and ignores repeats", () => {
    expect(parseTabList(html)).toEqual([{ gid: "0", title: "Class Data" }, { gid: "123", title: 'Leads & "Ads"' }]);
  });
  it("returns nothing for a page without a tab list", () => expect(parseTabList("<html>Sign in</html>")).toEqual([]));
});

describe("sheet url", () => {
  it("extracts the spreadsheet id and gid", () => {
    const u = "https://docs.google.com/spreadsheets/d/1l4jCxAY_vZXdb-MejHX2dc-VfOHp2906LuaX45NV6Kw/edit?gid=1316863377#gid=1316863377";
    expect(parseSheetUrl(u)).toEqual({ spreadsheetId: "1l4jCxAY_vZXdb-MejHX2dc-VfOHp2906LuaX45NV6Kw", gid: "1316863377" });
    expect(parseSheetUrl("https://evil.example/spreadsheets/d/abc")).toBeNull();
  });
  it("cleans owner names", () => expect(cleanAlias("📄 Fazal")).toBe("Fazal"));
});

describe("ids that lost digits", () => {
  it("refuses scientific-notation ids instead of letting leads collide", () => {
    const t = parseCsv("id,full_name\n1.23E+17,A\n1.23E+17,B\n99,C");
    const r = parseWorksheet(t, { ...DEFAULT_COLUMN_MAP, contact: [] }, TZ, fromZonedTime);
    expect(r.rows.map((x) => x.externalId)).toEqual(["99"]);
    expect(r.skipped[0].count).toBe(2);
  });
});

describe("dates with times", () => {
  const f = (v: string) => parseSheetDate(v, TZ, fromZonedTime)?.toISOString() ?? null;
  it("honours AM and PM", () => {
    expect(f("5/3/2026 3:45:00 PM")).toBe("2026-05-03T10:45:00.000Z"); // 15:45 PKT
    expect(f("5/3/2026 3:45 AM")).toBe("2026-05-02T22:45:00.000Z");
    expect(f("5/3/2026 12:10 AM")).toBe("2026-05-02T19:10:00.000Z"); // 00:10 PKT
    expect(f("5/3/2026 12:10 PM")).toBe("2026-05-03T07:10:00.000Z");
  });
  it("accepts 24-hour and ISO forms and rejects nonsense", () => {
    expect(f("2026-05-03 15:45")).toBe("2026-05-03T10:45:00.000Z");
    expect(f("5/3/2026 13:00 PM")).toBeNull();
    expect(f("13/40/2026")).toBeNull();
    expect(f("garbage")).toBeNull();
  });
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

describe("rows that only hold empty checkboxes", () => {
  it("are filler, not leads with a missing id", () => {
    const t = [["id", "full_name", "sales qualified", "onboarded"], ["", "", "FALSE", "FALSE"], ["A1", "Ana", "FALSE", "FALSE"], ["", "No Id Person", "FALSE", ""]];
    const r = parseWorksheet(t, { ...DEFAULT_COLUMN_MAP, contact: [] }, TZ, fromZonedTime);
    expect(r.rows.map((x) => x.externalId)).toEqual(["A1"]);
    expect(r.skipped).toEqual([{ reason: "no lead id", count: 1 }]); // a real row without an id is still reported
  });
});
