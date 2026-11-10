import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_COLUMN_MAP, parseWorksheet } from "./sheetparse";
import { isPlaceholderTitle, parseTabKeys, planTabSave, problemText, splitTabKey, tabKey, tabState, visibleTabTitle } from "./tabs";

const CONN = "0b0f1f6e-3a58-4c1d-9a3e-5f1d2b7c9e10";

describe("tab selection plan", () => {
  const live = ["1", "2", "3", "4"]; // FB Fazal, FB Bawar, TikTok Fazal, NEW

  it("keeps ticked syncing tabs, adds newly ticked ones, stops unticked ones", () => {
    expect(planTabSave(["1", "3"], live, ["1", "2"])).toEqual({ stop: ["2"], add: ["3"], keep: ["1"] });
  });
  it("never turns on a tab that was not ticked, including tabs discovered later", () => {
    const p = planTabSave(["1"], [...live, "99"], ["1"]);
    expect(p.add).toEqual([]);
    expect(p.keep).toEqual(["1"]);
  });
  it("ignores ticked ids that are not real tabs of the spreadsheet", () => {
    expect(planTabSave(["1", "777"], live, []).add).toEqual(["1"]);
  });
  it("does not stop a saved tab that is missing from the live list (a flaky list must not switch things off)", () => {
    expect(planTabSave([], ["1"], ["1", "gone"]).stop).toEqual(["1"]);
  });
  it("saving an empty selection stops everything but selects nothing new", () => {
    expect(planTabSave([], live, ["1", "2"])).toEqual({ stop: ["1", "2"], add: [], keep: [] });
  });
  it("is idempotent: saving the same selection twice changes nothing", () => {
    expect(planTabSave(["1", "2"], live, ["1", "2"])).toEqual({ stop: [], add: [], keep: ["1", "2"] });
  });
});

describe("tab state labels", () => {
  it("maps mappings to the status shown in the dropdown", () => {
    expect(tabState(undefined)).toBe("off");
    expect(tabState({ enabled: true, confirmedAt: new Date() })).toBe("syncing");
    expect(tabState({ enabled: true, confirmedAt: null })).toBe("waiting");
    expect(tabState({ enabled: false, confirmedAt: null }, true)).toBe("paused");
    expect(tabState({ enabled: false, confirmedAt: null }, false)).toBe("off");
  });
});

describe("tab names", () => {
  it("never shows an internal worksheet id", () => {
    expect(isPlaceholderTitle("Worksheet 1316863377")).toBe(true);
    expect(visibleTabTitle("Worksheet 1316863377")).toBe("Untitled tab");
    expect(visibleTabTitle("")).toBe("Untitled tab");
    expect(visibleTabTitle("Facebook Instant Form - WhatsApp (Fazal)")).toBe("Facebook Instant Form - WhatsApp (Fazal)");
  });
  it("names the exact tab and the missing fields in a warning", () => {
    expect(problemText({ gid: "3", title: "TikTok Ads (Fazal)", reason: "is missing Lead ID (id), Name (full_name)" }))
      .toBe("“TikTok Ads (Fazal)” is missing Lead ID (id), Name (full_name)");
  });
});

describe("tab filter keys", () => {
  it("parses comma separated and repeated values, drops junk and duplicates", () => {
    const a = tabKey(CONN, "10"), b = tabKey(CONN, "20");
    expect(parseTabKeys(`${a},${b},${a},nope,1;DROP`)).toEqual([a, b]);
    expect(parseTabKeys([a, b])).toEqual([a, b]);
    expect(parseTabKeys(undefined)).toEqual([]);
    expect(parseTabKeys("")).toEqual([]);
  });
  it("accepts a bare gid from an older link", () => {
    expect(parseTabKeys("1316863377")).toEqual(["1316863377"]);
  });
  it("round-trips a key", () => {
    expect(splitTabKey(tabKey(CONN, "55"))).toEqual({ connectionId: CONN, gid: "55" });
    expect(splitTabKey("55")).toEqual({ connectionId: null, gid: "55" });
  });
});

describe("lead counts: what a tab import actually counts", () => {
  const tz = "Asia/Karachi";
  const header = "Contacted y,Status,id,created_time,campaign_name,platform,full_name,whatsapp_number";
  const parse = (rows: string[]) => parseWorksheet([header, ...rows].map((r) => r.split(",")), DEFAULT_COLUMN_MAP, tz, fromZonedTime);

  it("does not count the header row, blank rows, or checkbox-only rows", () => {
    const r = parse([",,A1,11/2/2026,c,fb,Ann,0300", ",,,,,,,", "FALSE,FALSE,,,,,,", ",,A2,11/2/2026,c,fb,Bob,0301"]);
    expect(r.rows.map((x) => x.externalId)).toEqual(["A1", "A2"]);
  });
  it("does not count a repeated header or a row without an id or name as a lead", () => {
    const r = parse([",,A1,11/2/2026,c,fb,Ann,0300", ",,id,created_time,campaign_name,platform,full_name,whatsapp_number", ",,,11/2/2026,c,fb,No Id,0302", ",,A3,11/2/2026,c,fb,,0303"]);
    expect(r.rows.map((x) => x.externalId)).toEqual(["A1"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(["repeated header row", "no lead id", "no name"]));
  });
  it("counts a repeated lead id once", () => {
    const r = parse([",,A1,11/2/2026,c,fb,Ann,0300", ",,A1,11/2/2026,c,fb,Ann again,0300"]);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toEqual([{ reason: "repeated lead id", count: 1 }]);
  });
  it("reports exactly which required columns a tab lacks", () => {
    const r = parseWorksheet([["foo", "bar"], ["1", "2"]], DEFAULT_COLUMN_MAP, tz, fromZonedTime);
    expect(r.rows).toHaveLength(0);
    expect(r.missingColumns.join(" ")).toContain("Lead ID (“id”)");
    expect(r.missingColumns.join(" ")).toContain("Name (“full_name”)");
  });
});
