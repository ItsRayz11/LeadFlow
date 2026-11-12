/**
 * Pure scheduling rules for the follow-up engine. No database access, so every rule is unit-testable.
 *
 * Sequence: contact_started -> h24 -> h48 -> final -> completed.
 * Due times are anchored to the lead's recorded first contact (a real logged event), not to a label
 * and not to when the previous task happened to be closed.
 */
import { fromZonedTime, toZonedTime } from "date-fns-tz";

export const STEP_ORDER =["contact_started", "h24", "h48", "final"] as const;
export type Step = (typeof STEP_ORDER)[number];
export type LeadStep = Step | "completed";

export type Settings = {
  /** Hours after first contact for each follow-up. */
  h24: number;
  h48: number;
  hFinal: number;
  /** Never schedule a task sooner than this many minutes from now. */
  minGapMin: number;
  /** After an unanswered attempt, retry after this many minutes. */
  retryNoAnswerMin: number;
  /** Unanswered attempts on one task before the sequence moves on. The lead is never closed automatically. */
  maxNoAnswer: number;
  /** First contact is due this many minutes after a lead is assigned. */
  firstContactMin: number;
  /** Escalate to managers when a task has been overdue this long. */
  escalateAfterMin: number;
  /** Optional heads-up before the due time. 0 disables it. */
  advanceReminderMin: number;
  quiet: { enabled: boolean; start: string; end: string };
  /** Calendar days between one completed contact and the next follow-up. */
  followUpDays: number;
};

export const DEFAULT_SETTINGS: Settings = {
  h24: 24, h48: 48, hFinal: 72,
  minGapMin: 60, retryNoAnswerMin: 240, maxNoAnswer: 3, firstContactMin: 60,
  escalateAfterMin: 120, advanceReminderMin: 0,
  quiet: { enabled: true, start: "22:00", end: "07:00" },
  followUpDays: 7,
};

export function readSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  const n = (v: unknown, d: number, min = 0) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : d);
  const d = DEFAULT_SETTINGS;
  const q = (r.quiet ?? {}) as Partial<Settings["quiet"]>;
  const hhmm = (v: unknown, def: string) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : def);
  return {
    h24: n(r.h24, d.h24, 1), h48: n(r.h48, d.h48, 1), hFinal: n(r.hFinal, d.hFinal, 1),
    minGapMin: n(r.minGapMin, d.minGapMin), retryNoAnswerMin: n(r.retryNoAnswerMin, d.retryNoAnswerMin, 1),
    maxNoAnswer: n(r.maxNoAnswer, d.maxNoAnswer, 1), firstContactMin: n(r.firstContactMin, d.firstContactMin, 1),
    escalateAfterMin: n(r.escalateAfterMin, d.escalateAfterMin, 1), advanceReminderMin: n(r.advanceReminderMin, d.advanceReminderMin),
    quiet: { enabled: q.enabled ?? d.quiet.enabled, start: hhmm(q.start, d.quiet.start), end: hhmm(q.end, d.quiet.end) },
    followUpDays: Math.round(n(r.followUpDays, d.followUpDays, 1)),
  };
}

/** Same wall-clock time `days` calendar days later in the given zone (so a daylight-saving change cannot shift it by an hour). */
export function addCalendarDays(from: Date, days: number, tz: string): Date {
  const local = toZonedTime(from, tz);
  local.setDate(local.getDate() + days);
  return fromZonedTime(local, tz);
}

/** Interprets a plain calendar date ("2026-11-19") as 10:00 in the workspace zone. Returns null for anything else. */
export function dateAtMorning(ymd: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const d = fromZonedTime(`${ymd}T10:00:00`, tz);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MIN = 60_000;
const HOUR = 3_600_000;

/** After a completed contact the lead moves to the recurring follow-up (stored as "h24"; shown as "Follow-up"). Later steps stay as they are. */
export function stepAfter(step: LeadStep): Step {
  return step === "contact_started" || step === "completed" ? "h24" : (step as Step);
}

export function nextStep(step: LeadStep): Step | null {
  const i = STEP_ORDER.indexOf(step as Step);
  return i >= 0 && i < STEP_ORDER.length - 1 ? STEP_ORDER[i + 1] : null;
}

export function hoursFor(step: Step, s: Settings): number {
  return step === "h24" ? s.h24 : step === "h48" ? s.h48 : step === "final" ? s.hFinal : 0;
}

/**
 * Due time for a step. Anchored to the first recorded contact. If that moment has already passed
 * (a late 24H follow-up leaves the 48H one almost due), it is pushed to now + minGap so a task is
 * never created already overdue.
 */
export function dueFor(step: Step, anchor: Date, now: Date, s: Settings): Date {
  if (step === "contact_started") return new Date(now.getTime() + s.firstContactMin * MIN);
  const target = anchor.getTime() + hoursFor(step, s) * HOUR;
  const floor = now.getTime() + s.minGapMin * MIN;
  return new Date(Math.max(target, floor));
}

export function retryAt(now: Date, s: Settings): Date {
  return new Date(now.getTime() + s.retryNoAnswerMin * MIN);
}

export type Bucket = "overdue" | "now" | "today" | "upcoming";

/** Overdue state is computed from the clock. It never depends on a background job having run. */
export function bucketOf(due: Date, now: Date, tz: string): Bucket {
  if (due.getTime() < now.getTime()) return "overdue";
  if (due.getTime() - now.getTime() <= 30 * MIN) return "now";
  return dayKey(due, tz) === dayKey(now, tz) ? "today" : "upcoming";
}

/** Calendar day in the workspace time zone, e.g. "2026-11-04". */
export function dayKey(d: Date, tz: string): string {
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

/** Minutes since local midnight in the given zone. */
export function localMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export function inQuietHours(d: Date, tz: string, q: Settings["quiet"]): boolean {
  if (!q.enabled) return false;
  const [sh, sm] = q.start.split(":").map(Number);
  const [eh, em] = q.end.split(":").map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em, m = localMinutes(d, tz);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

export function escalationDue(due: Date, now: Date, s: Settings): boolean {
  return now.getTime() - due.getTime() >= s.escalateAfterMin * MIN;
}
