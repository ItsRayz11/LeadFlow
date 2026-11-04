import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS as S, bucketOf, dayKey, dueFor, escalationDue, inQuietHours, localMinutes, nextStep, readSettings, retryAt,
} from "./schedule";

const TZ = "Asia/Karachi"; // UTC+5, no DST
const at = (iso: string) => new Date(iso);

describe("sequence", () => {
  it("walks contact_started -> h24 -> h48 -> final -> end", () => {
    expect(nextStep("contact_started")).toBe("h24");
    expect(nextStep("h24")).toBe("h48");
    expect(nextStep("h48")).toBe("final");
    expect(nextStep("final")).toBeNull();
    expect(nextStep("completed")).toBeNull();
  });
});

describe("due times are anchored to the first recorded contact", () => {
  const first = at("2026-11-04T05:00:00Z"); // 10:00 PKT
  it("24H is 24 hours after first contact", () => {
    expect(dueFor("h24", first, at("2026-11-04T05:05:00Z"), S).toISOString()).toBe("2026-11-05T05:00:00.000Z");
  });
  it("48H stays at first contact + 48h even if the 24H task was closed late", () => {
    const lateNow = at("2026-11-05T20:00:00Z"); // 24H closed 15h late
    expect(dueFor("h48", first, lateNow, S).toISOString()).toBe("2026-11-06T05:00:00.000Z");
  });
  it("never creates a task that is already overdue", () => {
    const veryLate = at("2026-11-06T04:30:00Z");
    expect(dueFor("h48", first, veryLate, S).toISOString()).toBe("2026-11-06T05:30:00.000Z"); // now + 60 min
  });
  it("honours custom intervals", () => {
    const s = readSettings({ h24: 12, h48: 30, hFinal: 60 });
    expect(dueFor("h24", first, first, s).toISOString()).toBe("2026-11-04T17:00:00.000Z");
    expect(dueFor("final", first, first, s).toISOString()).toBe("2026-11-06T17:00:00.000Z");
  });
  it("first contact is due firstContactMin after now", () => {
    const now = at("2026-11-04T05:00:00Z");
    expect(dueFor("contact_started", now, now, S).toISOString()).toBe("2026-11-04T06:00:00.000Z");
  });
  it("no-answer retry uses the configured delay", () => {
    expect(retryAt(at("2026-11-04T05:00:00Z"), S).toISOString()).toBe("2026-11-04T09:00:00.000Z");
  });
});

describe("overdue is computed from the clock", () => {
  const now = at("2026-11-04T10:00:00Z"); // 15:00 PKT
  it("classifies buckets", () => {
    expect(bucketOf(at("2026-11-04T09:59:00Z"), now, TZ)).toBe("overdue");
    expect(bucketOf(at("2026-11-04T10:20:00Z"), now, TZ)).toBe("now");
    expect(bucketOf(at("2026-11-04T15:00:00Z"), now, TZ)).toBe("today"); // 20:00 PKT same day
    expect(bucketOf(at("2026-11-05T05:00:00Z"), now, TZ)).toBe("upcoming");
  });
  it("escalates only after the configured delay", () => {
    expect(escalationDue(at("2026-11-04T08:30:00Z"), now, S)).toBe(false);
    expect(escalationDue(at("2026-11-04T07:59:00Z"), now, S)).toBe(true);
  });
});

describe("Pakistan time zone boundaries", () => {
  it("19:30 UTC is already the next day in Karachi", () => {
    expect(dayKey(at("2026-11-04T19:30:00Z"), TZ)).toBe("2026-11-05");
    expect(dayKey(at("2026-11-04T18:59:00Z"), TZ)).toBe("2026-11-04");
  });
  it("a 23:50 PKT task is 'today', a 00:10 PKT task is 'upcoming'", () => {
    const now = at("2026-11-04T10:00:00Z"); // 15:00 PKT
    expect(bucketOf(at("2026-11-04T18:50:00Z"), now, TZ)).toBe("today");
    expect(bucketOf(at("2026-11-04T19:10:00Z"), now, TZ)).toBe("upcoming");
  });
  it("converts to local minutes", () => {
    expect(localMinutes(at("2026-11-04T19:30:00Z"), TZ)).toBe(30);
  });
});

describe("quiet hours", () => {
  const q = { enabled: true, start: "22:00", end: "07:00" };
  it("wraps midnight", () => {
    expect(inQuietHours(at("2026-11-04T17:30:00Z"), TZ, q)).toBe(true); // 22:30 PKT
    expect(inQuietHours(at("2026-11-04T21:00:00Z"), TZ, q)).toBe(true); // 02:00 PKT
    expect(inQuietHours(at("2026-11-04T10:00:00Z"), TZ, q)).toBe(false); // 15:00 PKT
    expect(inQuietHours(at("2026-11-04T02:00:00Z"), TZ, q)).toBe(false); // 07:00 PKT exactly
  });
  it("can be disabled", () => {
    expect(inQuietHours(at("2026-11-04T21:00:00Z"), TZ, { ...q, enabled: false })).toBe(false);
  });
});

describe("settings parsing", () => {
  it("falls back to defaults on bad input", () => {
    expect(readSettings(null)).toEqual(S);
    expect(readSettings({ h24: -5, h48: "x" }).h24).toBe(24);
  });
});
