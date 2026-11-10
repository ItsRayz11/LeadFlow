import "server-only";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { everInterested, lost, scope } from "@/lib/leads";
import type { Ctx } from "@/lib/session";

const L = schema.lead;
const T = schema.followUpTask;
const A = schema.leadActivity;
const M = schema.workspaceMember;

export const PERIODS = [
  { key: "today", label: "Today", from: 0, to: 0 },
  { key: "yesterday", label: "Yesterday", from: 1, to: 1 },
  { key: "7d", label: "Last 7 days", from: 6, to: 0 },
  { key: "30d", label: "Last 30 days", from: 29, to: 0 },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

export type Filters = { period: PeriodKey; ownerId?: string; source?: string };

const localDay = (col: unknown, tz: string) => sql`(${col} at time zone ${tz})::date`;
const todayDay = (tz: string) => sql`(now() at time zone ${tz})::date`;
const inRange = (col: unknown, tz: string, fromBack: number, toBack: number) =>
  sql`${localDay(col, tz)} between ${todayDay(tz)} - ${fromBack}::int and ${todayDay(tz)} - ${toBack}::int`;

export function parseFilters(c: Ctx, sp: Record<string, string | undefined>): Filters {
  const period = (PERIODS.find((p) => p.key === sp.period)?.key ?? "7d") as PeriodKey;
  const mgr = c.role === "admin" || c.role === "manager";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    period,
    ownerId: mgr && sp.owner && uuid.test(sp.owner) ? sp.owner : undefined,
    source: sp.source ? sp.source.slice(0, 80) : undefined,
  };
}

/** Lead scope for this viewer (BDs only ever see their own leads) plus the chosen filters. */
function leadWhere(c: Ctx, f: Filters, extra?: SQL): SQL {
  const parts: SQL[] = [scope(c)];
  if (f.ownerId) parts.push(eq(L.ownerId, f.ownerId));
  if (f.source) parts.push(f.source === "(none)" ? isNull(L.source) : eq(L.source, f.source));
  if (extra) parts.push(extra);
  return and(...parts)!;
}

/** Leads with no arrival date in the sheet carry the import time instead; counting them as "arrived" would fake a spike. */
const dated = sql`coalesce(${L.custom}->>'acquiredDateMissing', '') <> 'true'`;

const range = (f: Filters, back = 0) => {
  const p = PERIODS.find((x) => x.key === f.period)!;
  const len = p.from - p.to + 1;
  // back = 1 gives the equally long period right before this one.
  return { from: p.from + len * back, to: p.to + len * back };
};

export type Summary = {
  newLeads: number; firstContacted: number; attempts: number; converted: number; closed: number;
  avgFirstContactHrs: number | null; missed: number;
};

export async function summary(c: Ctx, f: Filters, back = 0): Promise<Summary> {
  const r = range(f, back);
  const [a] = await db.select({
    newLeads: sql<number>`count(*) filter (where ${inRange(L.acquiredAt, c.tz, r.from, r.to)} and ${dated})::int`,
    firstContacted: sql<number>`count(*) filter (where ${inRange(L.firstContactedAt, c.tz, r.from, r.to)})::int`,
    converted: sql<number>`count(*) filter (where ${inRange(L.convertedAt, c.tz, r.from, r.to)})::int`,
    closed: sql<number>`count(*) filter (where ${inRange(L.closedAt, c.tz, r.from, r.to)})::int`,
    avgFirstContactHrs: sql<number | null>`avg(extract(epoch from (${L.firstContactedAt} - ${L.acquiredAt})) / 3600) filter (where ${inRange(L.firstContactedAt, c.tz, r.from, r.to)} and ${L.firstContactedAt} >= ${L.acquiredAt})`,
  }).from(L).where(leadWhere(c, f));

  const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(A).innerJoin(L, eq(L.id, A.leadId))
    .where(and(leadWhere(c, f), inArray(A.type, ["contacted", "no_answer"]), inRange(A.occurredAt, c.tz, r.from, r.to)));
  const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(T).innerJoin(L, eq(L.id, T.leadId))
    .where(and(leadWhere(c, f), sql`${T.firstMissedAt} is not null`, inRange(T.firstMissedAt, c.tz, r.from, r.to)));
  return { ...a, avgFirstContactHrs: a.avgFirstContactHrs == null ? null : Number(a.avgFirstContactHrs), attempts: b.n, missed: m.n };
}

/** Right-now numbers that do not depend on the period. */
export async function snapshot(c: Ctx, f: Filters) {
  const [r] = await db.select({
    active: sql<number>`count(*) filter (where ${L.closedAt} is null)::int`,
    unassigned: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.ownerId} is null)::int`,
    overdue: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.nextFollowUpAt} < now())::int`,
  }).from(L).where(leadWhere(c, f));
  return r;
}

export type Pipeline = {
  total: number; active: number; contacted: number; interestedEver: number; interestedNow: number; converted: number;
  lost: number; lostAfterInterest: number; lostNotInterested: number; lostNoResponse: number; lostOther: number;
  stages: { key: string; n: number }[]; statuses: { key: string; n: number }[]; reasons: { reason: string; n: number }[];
};

/** Where every lead in view stands right now, and how far each got. Not tied to the period: this is the whole funnel. */
export async function pipeline(c: Ctx, f: Filters): Promise<Pipeline> {
  const [a] = await db.select({
    total: sql<number>`count(*)::int`,
    active: sql<number>`count(*) filter (where ${L.closedAt} is null)::int`,
    contacted: sql<number>`count(*) filter (where ${L.status} <> 'new' or ${L.firstContactedAt} is not null)::int`,
    interestedEver: sql<number>`count(*) filter (where ${everInterested})::int`,
    interestedNow: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.status} in ('interested', 'proposal_sent'))::int`,
    converted: sql<number>`count(*) filter (where ${L.status} = 'converted')::int`,
    lost: sql<number>`count(*) filter (where ${lost})::int`,
    lostAfterInterest: sql<number>`count(*) filter (where ${lost} and ${everInterested})::int`,
    lostNotInterested: sql<number>`count(*) filter (where ${lost} and ${L.status} = 'not_interested')::int`,
    lostNoResponse: sql<number>`count(*) filter (where ${lost} and ${L.status} = 'no_response')::int`,
  }).from(L).where(leadWhere(c, f));
  const stages = await db.select({ key: sql<string>`${L.followUpStep}::text`, n: sql<number>`count(*)::int` }).from(L)
    .where(leadWhere(c, f, isNull(L.closedAt))).groupBy(sql`1`);
  const statuses = await db.select({ key: sql<string>`${L.status}::text`, n: sql<number>`count(*)::int` }).from(L)
    .where(leadWhere(c, f)).groupBy(sql`1`);
  const reasons = await db.select({ reason: sql<string>`${L.closureReason}`, n: sql<number>`count(*)::int` }).from(L)
    .where(leadWhere(c, f, and(lost, sql`${L.closureReason} is not null`))).groupBy(sql`1`).orderBy(sql`2 desc`).limit(6);
  return { ...a, lostOther: Math.max(0, a.lost - a.lostNotInterested - a.lostNoResponse), stages, statuses, reasons };
}

export type DayRow = { day: string; newLeads: number; contacted: number; converted: number };

/** One row per local day, zero-filled, for the chosen period (at least 7 days so a single day still shows context). */
export async function daily(c: Ctx, f: Filters): Promise<DayRow[]> {
  const r = range(f);
  const span = Math.max(r.from, 6);
  const byDay = async (col: unknown) => {
    const rows = await db.select({ day: sql<string>`to_char(${localDay(col, c.tz)}, 'YYYY-MM-DD')`, n: sql<number>`count(*)::int` })
      .from(L).where(leadWhere(c, f, col === L.acquiredAt ? and(inRange(col, c.tz, span, r.to), dated) : inRange(col, c.tz, span, r.to))).groupBy(sql`1`);
    return new Map(rows.map((x) => [x.day, x.n]));
  };
  const [a, k, v] = await Promise.all([byDay(L.acquiredAt), byDay(L.firstContactedAt), byDay(L.convertedAt)]);
  const [{ today }] = await db.select({ today: sql<string>`to_char(${todayDay(c.tz)}, 'YYYY-MM-DD')` }).from(sql`(select 1) x`);
  const [y, mo, d] = today.split("-").map(Number);
  const out: DayRow[] = [];
  for (let back = span; back >= r.to; back--) {
    const dt = new Date(Date.UTC(y, mo - 1, d - back));
    const key = dt.toISOString().slice(0, 10);
    out.push({ day: key, newLeads: a.get(key) ?? 0, contacted: k.get(key) ?? 0, converted: v.get(key) ?? 0 });
  }
  return out;
}

export type OwnerRow = {
  memberId: string; name: string; role: string; open: number; overdue: number; firstContacted: number; attempts: number;
  converted: number; missed: number; avgFirstContactHrs: number | null;
};

/** Per-BD rows. Deliberately not ranked by how many leads someone was handed: outcomes and discipline are shown side by side. */
export async function byOwner(c: Ctx, f: Filters): Promise<OwnerRow[]> {
  if (c.role !== "admin" && c.role !== "manager") return [];
  const r = range(f);
  const base = { ...f, ownerId: undefined };
  const [members, lead, att, mis] = await Promise.all([
    db.select({ id: M.id, userId: M.userId, name: M.displayName, role: M.role }).from(M)
      .where(and(eq(M.workspaceId, c.workspaceId), eq(M.active, true))).orderBy(asc(M.displayName)),
    db.select({
      ownerId: L.ownerId,
      open: sql<number>`count(*) filter (where ${L.closedAt} is null)::int`,
      overdue: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.nextFollowUpAt} < now())::int`,
      firstContacted: sql<number>`count(*) filter (where ${inRange(L.firstContactedAt, c.tz, r.from, r.to)})::int`,
      converted: sql<number>`count(*) filter (where ${inRange(L.convertedAt, c.tz, r.from, r.to)})::int`,
      avg: sql<number | null>`avg(extract(epoch from (${L.firstContactedAt} - ${L.acquiredAt})) / 3600) filter (where ${inRange(L.firstContactedAt, c.tz, r.from, r.to)} and ${L.firstContactedAt} >= ${L.acquiredAt})`,
    }).from(L).where(leadWhere(c, base)).groupBy(L.ownerId),
    // Attempts are credited to the person who logged them, not to the lead's current owner.
    db.select({ actor: A.actorId, n: sql<number>`count(*)::int` }).from(A).innerJoin(L, eq(L.id, A.leadId))
      .where(and(leadWhere(c, base), inArray(A.type, ["contacted", "no_answer"]), inRange(A.occurredAt, c.tz, r.from, r.to))).groupBy(A.actorId),
    db.select({ ownerId: T.ownerId, n: sql<number>`count(*)::int` }).from(T).innerJoin(L, eq(L.id, T.leadId))
      .where(and(leadWhere(c, base), sql`${T.firstMissedAt} is not null`, inRange(T.firstMissedAt, c.tz, r.from, r.to))).groupBy(T.ownerId),
  ]);
  const lm = new Map(lead.map((x) => [x.ownerId, x]));
  const am = new Map(att.map((x) => [x.actor, x.n]));
  const mm = new Map(mis.map((x) => [x.ownerId, x.n]));
  return members.filter((m) => m.role !== "viewer").map((m) => {
    const l = lm.get(m.id);
    return {
      memberId: m.id, name: m.name, role: m.role, open: l?.open ?? 0, overdue: l?.overdue ?? 0, firstContacted: l?.firstContacted ?? 0,
      attempts: am.get(m.userId) ?? 0, converted: l?.converted ?? 0, missed: mm.get(m.id) ?? 0,
      avgFirstContactHrs: l?.avg == null ? null : Number(l.avg),
    };
  });
}

export type SourceRow = { source: string; leads: number; contacted: number; converted: number };

/** Leads acquired in the period, grouped by where they came from. */
export async function bySource(c: Ctx, f: Filters): Promise<SourceRow[]> {
  const r = range(f);
  return db.select({
    source: sql<string>`coalesce(${L.source}, '(none)')`,
    leads: sql<number>`count(*)::int`,
    contacted: sql<number>`count(${L.firstContactedAt})::int`,
    converted: sql<number>`count(${L.convertedAt})::int`,
  }).from(L).where(leadWhere(c, { ...f, source: undefined }, and(inRange(L.acquiredAt, c.tz, r.from, r.to), dated)))
    .groupBy(sql`1`).orderBy(sql`2 desc`).limit(25);
}

/** Activation milestones reached by leads acquired in the period. */
export async function milestones(c: Ctx, f: Filters) {
  const r = range(f);
  const [x] = await db.select({
    leads: sql<number>`count(*)::int`,
    appDownloaded: sql<number>`count(${L.appDownloadedAt})::int`,
    referralShared: sql<number>`count(${L.referralSharedAt})::int`,
    cardPurchased: sql<number>`count(${L.cardPurchasedAt})::int`,
    spendingStarted: sql<number>`count(${L.spendingStartedAt})::int`,
    converted: sql<number>`count(${L.convertedAt})::int`,
  }).from(L).where(leadWhere(c, f, and(inRange(L.acquiredAt, c.tz, r.from, r.to), dated)));
  return x;
}

export async function sourceOptions(c: Ctx): Promise<string[]> {
  const rows = await db.selectDistinct({ s: sql<string>`coalesce(${L.source}, '(none)')` }).from(L).where(scope(c)).orderBy(sql`1`).limit(100);
  return rows.map((x) => x.s);
}

/** Spreadsheet formulas in exported cells would run when opened in Excel; neutralise them. */
export const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// The byte-order mark makes Excel read names with accents or Urdu text correctly.
export const toCsv = (rows: unknown[][]) => "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
