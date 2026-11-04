import "server-only";
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { scope } from "@/lib/leads";
import type { Ctx } from "@/lib/session";

const L = schema.lead;
const T = schema.followUpTask;
const M = schema.workspaceMember;

export type View = "now" | "today" | "overdue" | "upcoming" | "completed" | "unassigned" | "mine" | "team" | "decide";

export const VIEWS: { key: View; label: string; manager?: boolean }[] = [
  { key: "mine", label: "My follow-ups" },
  { key: "now", label: "Due now" },
  { key: "today", label: "Due today" },
  { key: "overdue", label: "Overdue" },
  { key: "upcoming", label: "Upcoming" },
  { key: "unassigned", label: "Unassigned" },
  { key: "decide", label: "Needs decision" },
  { key: "completed", label: "Completed" },
  { key: "team", label: "Team follow-ups", manager: true },
];

const localDay = (col: unknown, tz: string) => sql`(${col} at time zone ${tz})::date`;
const todayDay = (tz: string) => sql`(now() at time zone ${tz})::date`;

function viewFilter(view: View, c: Ctx): SQL | undefined {
  switch (view) {
    case "overdue": return sql`${T.dueAt} < now()`;
    case "now": return sql`${T.dueAt} >= now() and ${T.dueAt} <= now() + interval '30 minutes'`;
    case "today": return sql`${T.dueAt} >= now() and ${localDay(T.dueAt, c.tz)} = ${todayDay(c.tz)}`;
    case "upcoming": return sql`${localDay(T.dueAt, c.tz)} > ${todayDay(c.tz)}`;
    case "unassigned": return isNull(L.ownerId);
    case "mine": return and(eq(L.ownerId, c.memberId), sql`${T.id} is not null`);
    case "team": return sql`${T.id} is not null`;
    case "decide": return and(isNull(T.id), eq(L.followUpStep, "completed"));
    default: return undefined;
  }
}

/** Open leads joined to their single pending task. Overdue is derived from the clock, not stored. */
const openBase = (c: Ctx) =>
  db.select({
    leadId: L.id, name: L.name, phone: L.phoneRaw, source: L.source, ownerId: L.ownerId, owner: M.displayName,
    leadStep: L.followUpStep, status: L.status, attempts: L.followUpAttempts, lastResult: L.lastResult, priority: L.priority,
    taskId: T.id, step: T.step, dueAt: T.dueAt, taskAttempts: T.attempts, missedAt: T.firstMissedAt, escalatedAt: T.escalatedAt,
  })
    .from(L)
    .leftJoin(T, and(eq(T.leadId, L.id), eq(T.status, "pending")))
    .leftJoin(M, eq(M.id, L.ownerId));

export type Row = Awaited<ReturnType<typeof listFollowUps>>[number];

export async function listFollowUps(c: Ctx, o: { view: View; q?: string; sort?: string; ownerId?: string }) {
  const q = (o.q ?? "").trim();
  const digits = q.replace(/\D/g, "");
  const where = and(
    scope(c), isNull(L.closedAt), viewFilter(o.view, c),
    o.ownerId ? eq(L.ownerId, o.ownerId) : undefined,
    q ? or(ilike(L.name, `%${q}%`), digits.length >= 3 ? ilike(L.phoneNorm, `%${digits}%`) : undefined) : undefined,
  );
  const order = o.sort === "-due" ? [sql`${T.dueAt} desc nulls last`] : o.sort === "name" ? [asc(L.name)] : o.sort === "owner" ? [asc(M.displayName), sql`${T.dueAt} asc nulls last`] : [sql`${T.dueAt} asc nulls last`, desc(L.acquiredAt)];
  return openBase(c).where(where).orderBy(...order).limit(300);
}

export async function listCompleted(c: Ctx, o: { q?: string; ownerId?: string }) {
  const q = (o.q ?? "").trim();
  return db.select({
    leadId: L.id, name: L.name, phone: L.phoneRaw, owner: M.displayName, step: T.step, outcome: T.outcome, channel: T.channel,
    completedAt: T.completedAt, notes: T.notes,
  })
    .from(T).innerJoin(L, eq(L.id, T.leadId)).leftJoin(M, eq(M.id, T.ownerId))
    .where(and(scope(c), eq(T.status, "completed"), o.ownerId ? eq(T.ownerId, o.ownerId) : undefined, q ? ilike(L.name, `%${q}%`) : undefined))
    .orderBy(desc(T.completedAt)).limit(200);
}

export async function viewCounts(c: Ctx) {
  const [r] = await db.select({
    mine: sql<number>`count(*) filter (where ${L.ownerId} = ${c.memberId} and ${T.id} is not null)::int`,
    now: sql<number>`count(*) filter (where ${T.dueAt} >= now() and ${T.dueAt} <= now() + interval '30 minutes')::int`,
    today: sql<number>`count(*) filter (where ${T.dueAt} >= now() and ${localDay(T.dueAt, c.tz)} = ${todayDay(c.tz)})::int`,
    overdue: sql<number>`count(*) filter (where ${T.dueAt} < now())::int`,
    upcoming: sql<number>`count(*) filter (where ${localDay(T.dueAt, c.tz)} > ${todayDay(c.tz)})::int`,
    unassigned: sql<number>`count(*) filter (where ${L.ownerId} is null)::int`,
    decide: sql<number>`count(*) filter (where ${T.id} is null and ${L.followUpStep} = 'completed')::int`,
    team: sql<number>`count(*) filter (where ${T.id} is not null)::int`,
  })
    .from(L).leftJoin(T, and(eq(T.leadId, L.id), eq(T.status, "pending")))
    .where(and(scope(c), isNull(L.closedAt)));
  const [{ done }] = await db.select({ done: sql<number>`count(*)::int` }).from(T).innerJoin(L, eq(L.id, T.leadId))
    .where(and(scope(c), eq(T.status, "completed")));
  return { ...r, completed: done } as Record<View, number>;
}

/** Per-owner workload for managers. Everything here is counted from tasks, with no job required. */
export async function ownerStats(c: Ctx) {
  return db.select({
    memberId: M.id, name: M.displayName, role: M.role, active: M.active,
    open: sql<number>`count(distinct ${L.id}) filter (where ${L.closedAt} is null)::int`,
    pending: sql<number>`count(${T.id})::int`,
    dueToday: sql<number>`count(${T.id}) filter (where ${T.dueAt} >= now() and ${localDay(T.dueAt, c.tz)} = ${todayDay(c.tz)})::int`,
    overdue: sql<number>`count(${T.id}) filter (where ${T.dueAt} < now())::int`,
    escalated: sql<number>`count(${T.id}) filter (where ${T.escalatedAt} is not null)::int`,
    oldestOverdue: sql<Date | null>`min(${T.dueAt}) filter (where ${T.dueAt} < now())`,
  })
    .from(M)
    .leftJoin(L, and(eq(L.ownerId, M.id), isNull(L.mergedIntoId)))
    .leftJoin(T, and(eq(T.leadId, L.id), eq(T.status, "pending"), isNull(L.closedAt)))
    .where(eq(M.workspaceId, c.workspaceId))
    .groupBy(M.id, M.displayName, M.role, M.active)
    .orderBy(asc(M.displayName));
}

/** Count of deadlines ever missed per owner (history, even if later resolved). */
export async function missedHistory(c: Ctx) {
  return db.select({ ownerId: T.ownerId, missed: sql<number>`count(*)::int` })
    .from(T).where(and(eq(T.workspaceId, c.workspaceId), sql`${T.firstMissedAt} is not null`)).groupBy(T.ownerId);
}
