import "server-only";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Ctx } from "@/lib/session";

const L = schema.lead;

/** Base filter: this workspace, not merged away, and (for BDs) only their own leads. */
export function scope(c: Ctx): SQL {
  const parts = [eq(L.workspaceId, c.workspaceId), isNull(L.mergedIntoId)];
  if (c.role === "bd") parts.push(eq(L.ownerId, c.memberId));
  return and(...parts)!;
}

const dayOf = (col: unknown, tz: string) => sql`(${col} at time zone ${tz})::date`;
const today = (tz: string) => sql`(now() at time zone ${tz})::date`;

export async function overviewMetrics(c: Ctx) {
  const [r] = await db
    .select({
      newToday: sql<number>`count(*) filter (where ${dayOf(L.acquiredAt, c.tz)} = ${today(c.tz)})::int`,
      newYesterday: sql<number>`count(*) filter (where ${dayOf(L.acquiredAt, c.tz)} = ${today(c.tz)} - 1)::int`,
      active: sql<number>`count(*) filter (where ${L.closedAt} is null)::int`,
      unassigned: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.ownerId} is null)::int`,
      contactedToday: sql<number>`count(*) filter (where ${dayOf(L.lastContactedAt, c.tz)} = ${today(c.tz)})::int`,
      convertedToday: sql<number>`count(*) filter (where ${dayOf(L.convertedAt, c.tz)} = ${today(c.tz)})::int`,
      closedToday: sql<number>`count(*) filter (where ${dayOf(L.closedAt, c.tz)} = ${today(c.tz)})::int`,
      overdue: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.nextFollowUpAt} < now())::int`,
      dueToday: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.nextFollowUpAt} >= now() and ${dayOf(L.nextFollowUpAt, c.tz)} = ${today(c.tz)})::int`,
    })
    .from(L)
    .where(scope(c));
  return r;
}

/**
 * A lead showed interest if it is interested now, or its history says it was at some point (an outcome logged as interested, or a status
 * that moved to interested, whether typed in the CRM or brought in from the sheet). This is what makes "dropped after interest" countable.
 */
export const everInterested = sql`(${L.status} in ('interested', 'proposal_sent', 'converted') or exists (
  select 1 from lead_activity a where a.lead_id = ${L.id}
    and (a.outcome = 'interested' or a.data->>'status' = 'interested' or a.data->'changes'->'status'->>'to' = 'interested')))`;
/** Closed without converting. */
export const lost = sql`(${L.closedAt} is not null and coalesce(${L.outcome}::text, '') <> 'converted')`;

export type Seg = "all" | "new_today" | "unassigned" | "active" | "closed" | "overdue" | "interested" | "converted" | "lost" | "lost_interested";
export const SEGS: [Seg, string][] = [
  ["all", "All"], ["new_today", "New today"], ["unassigned", "Unassigned"],
  ["overdue", "Overdue"], ["active", "Active"], ["interested", "Interested"], ["converted", "Converted"],
  ["lost_interested", "Dropped after interest"], ["lost", "Lost"], ["closed", "Closed"],
];

export function segFilter(seg: Seg, tz: string): SQL | undefined {
  switch (seg) {
    case "new_today": return sql`${dayOf(L.acquiredAt, tz)} = ${today(tz)}`;
    case "unassigned": return and(isNull(L.closedAt), isNull(L.ownerId));
    case "overdue": return sql`${L.closedAt} is null and ${L.nextFollowUpAt} < now()`;
    case "active": return isNull(L.closedAt);
    case "closed": return sql`${L.closedAt} is not null`;
    case "interested": return sql`${L.closedAt} is null and ${L.status} in ('interested', 'proposal_sent')`;
    case "converted": return sql`${L.status} = 'converted'`;
    case "lost": return lost;
    case "lost_interested": return sql`${lost} and ${everInterested}`;
    default: return undefined;
  }
}

/** Limits to leads imported from one worksheet tab (by its gid). Empty means every tab. */
export function tabFilter(tab: string): SQL | undefined {
  return /^\d{1,12}$/.test(tab) ? eq(L.sheetGid, tab) : undefined;
}

/** The tabs being tracked in this workspace, with how many leads each has in the caller's scope. */
export async function trackedTabs(c: Ctx) {
  const tabs = await db.select({ gid: schema.worksheetMapping.sheetGid, title: schema.worksheetMapping.sheetTitle })
    .from(schema.worksheetMapping)
    .innerJoin(schema.spreadsheetConnection, eq(schema.spreadsheetConnection.id, schema.worksheetMapping.connectionId))
    .where(and(eq(schema.spreadsheetConnection.workspaceId, c.workspaceId), eq(schema.worksheetMapping.enabled, true)))
    .orderBy(schema.worksheetMapping.sheetTitle);
  const n = await db.select({ gid: L.sheetGid, n: sql<number>`count(*)::int` }).from(L).where(scope(c)).groupBy(L.sheetGid);
  const by = new Map(n.map((x) => [x.gid, x.n]));
  return tabs.map((t) => ({ ...t, n: by.get(t.gid) ?? 0 }));
}

export async function listLeads(c: Ctx, seg: Seg, q: string, tab = "") {
  const search = q.trim();
  const digits = search.replace(/\D/g, "");
  const where = and(
    scope(c),
    tabFilter(tab),
    segFilter(seg, c.tz),
    search
      ? or(ilike(L.name, `%${search}%`), digits.length >= 3 ? ilike(L.phoneNorm, `%${digits}%`) : undefined)
      : undefined,
  );
  return db
    .select({
      id: L.id, name: L.name, phone: L.phoneRaw, source: L.source, status: L.status, outcome: L.outcome,
      nextFollowUpAt: L.nextFollowUpAt, acquiredAt: L.acquiredAt, closedAt: L.closedAt,
      owner: schema.workspaceMember.displayName,
      ms: sql<number>`(${L.appDownloadedAt} is not null)::int + (${L.referralSharedAt} is not null)::int + (${L.cardPurchasedAt} is not null)::int + (${L.spendingStartedAt} is not null)::int`,
    })
    .from(L)
    .leftJoin(schema.workspaceMember, eq(schema.workspaceMember.id, L.ownerId))
    .where(where)
    .orderBy(desc(L.acquiredAt))
    .limit(200);
}

export async function segCounts(c: Ctx, tab = "") {
  const [r] = await db
    .select({
      all: sql<number>`count(*)::int`,
      new_today: sql<number>`count(*) filter (where ${dayOf(L.acquiredAt, c.tz)} = ${today(c.tz)})::int`,
      unassigned: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.ownerId} is null)::int`,
      overdue: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.nextFollowUpAt} < now())::int`,
      active: sql<number>`count(*) filter (where ${L.closedAt} is null)::int`,
      closed: sql<number>`count(*) filter (where ${L.closedAt} is not null)::int`,
      interested: sql<number>`count(*) filter (where ${L.closedAt} is null and ${L.status} in ('interested', 'proposal_sent'))::int`,
      converted: sql<number>`count(*) filter (where ${L.status} = 'converted')::int`,
      lost: sql<number>`count(*) filter (where ${lost})::int`,
      lost_interested: sql<number>`count(*) filter (where ${lost} and ${everInterested})::int`,
    })
    .from(L)
    .where(and(scope(c), tabFilter(tab)));
  return r as Record<Seg, number>;
}

export function relTime(d: Date | null, now = Date.now()) {
  if (!d) return "None";
  const diff = d.getTime() - now;
  const a = Math.abs(diff) / 36e5;
  const s = a < 1 ? `${Math.max(1, Math.round(a * 60))} min` : a < 48 ? `${Math.round(a)} h` : `${Math.round(a / 24)} d`;
  return diff < 0 ? `${s} overdue` : `in ${s}`;
}
