import "server-only";
import { and, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { after } from "next/server";
import { db, schema } from "@/db";
import { dbTx } from "@/db/tx";
import { notify } from "@/lib/notify";
import { inQuietHours, readSettings } from "@/lib/schedule";

const T = schema.followUpTask;
const MIN = 60_000;
const OVERDUE_ALERT_MIN = 60;
const MAX_DELIVERY_ATTEMPTS = 6;

export type SweepResult = { workspaces: number; missed: number; reminders: number; escalated: number; delivered: number; failed: number };

/**
 * Background pass. It is safe to run any number of times, from any trigger (cron, external pinger, a page load):
 * every write is guarded by a unique key or a conditional update, so repeats change nothing.
 *
 * The follow-up queues and "overdue" state do not depend on this running. They are computed from due times.
 * This job only records missed-deadline history, creates notifications, escalates, and delivers external messages.
 */
export async function sweep(onlyWorkspaceId?: string): Promise<SweepResult> {
  const out: SweepResult = { workspaces: 0, missed: 0, reminders: 0, escalated: 0, delivered: 0, failed: 0 };
  const workspaces = await db.select().from(schema.workspace).where(onlyWorkspaceId ? eq(schema.workspace.id, onlyWorkspaceId) : undefined);

  for (const w of workspaces) {
    out.workspaces++;
    const s = readSettings(w.settings);
    const now = new Date();

    await dbTx.transaction(async (tx) => {
      // 1. Persist the first missed deadline (history). The row updates only once per task.
      const missed = await tx.update(T).set({ firstMissedAt: now })
        .where(and(eq(T.workspaceId, w.id), eq(T.status, "pending"), lt(T.dueAt, now), isNull(T.firstMissedAt)))
        .returning({ id: T.id, leadId: T.leadId, dueAt: T.dueAt });
      for (const m of missed) {
        await tx.insert(schema.leadActivity).values({
          leadId: m.leadId, workspaceId: w.id, type: "followup_missed", actorId: null,
          summary: "Follow-up deadline missed", data: { taskId: m.id, dueAt: m.dueAt }, idempotencyKey: `missed:${m.id}`,
        }).onConflictDoNothing();
      }
      out.missed += missed.length;

      // 2. Reminders, each created once per task.
      const open = await tx.select({
        id: T.id, leadId: T.leadId, ownerId: T.ownerId, dueAt: T.dueAt, step: T.step, name: schema.lead.name,
      }).from(T).innerJoin(schema.lead, eq(schema.lead.id, T.leadId))
        .where(and(eq(T.workspaceId, w.id), eq(T.status, "pending"), isNull(schema.lead.closedAt),
          lte(T.dueAt, new Date(now.getTime() + Math.max(s.advanceReminderMin, 0) * MIN))));
      for (const t of open) {
        if (!t.ownerId) continue;
        const base = { workspaceId: w.id, memberId: t.ownerId, leadId: t.leadId, taskId: t.id };
        const late = now.getTime() - t.dueAt.getTime();
        if (t.dueAt.getTime() > now.getTime()) {
          if (s.advanceReminderMin > 0 && await notify(tx, { ...base, kind: "advance", title: `Coming up: ${t.name}`, body: `Follow-up due in ${Math.ceil((t.dueAt.getTime() - now.getTime()) / MIN)} min`, dedupeKey: `adv:${t.id}` })) out.reminders++;
          continue;
        }
        if (await notify(tx, { ...base, kind: "due", title: `Follow up: ${t.name}`, body: "This follow-up is due.", dedupeKey: `due:${t.id}` })) out.reminders++;
        if (late >= OVERDUE_ALERT_MIN * MIN && await notify(tx, { ...base, kind: "overdue", title: `Overdue: ${t.name}`, body: "Still not done. It stays on your list until resolved.", dedupeKey: `overdue:${t.id}` })) out.reminders++;
      }

      // 3. Manager escalation after the configured delay. escalatedAt makes this once-only.
      const esc = await tx.update(T).set({ escalatedAt: now })
        .where(and(eq(T.workspaceId, w.id), eq(T.status, "pending"), isNull(T.escalatedAt), lt(T.dueAt, new Date(now.getTime() - s.escalateAfterMin * MIN))))
        .returning({ id: T.id, leadId: T.leadId, ownerId: T.ownerId });
      if (esc.length) {
        const managers = await tx.select({ id: schema.workspaceMember.id }).from(schema.workspaceMember)
          .where(and(eq(schema.workspaceMember.workspaceId, w.id), eq(schema.workspaceMember.active, true), inArray(schema.workspaceMember.role, ["admin", "manager"])));
        const names = await tx.select({ id: schema.lead.id, name: schema.lead.name }).from(schema.lead).where(inArray(schema.lead.id, esc.map((e) => e.leadId)));
        const nameOf = new Map(names.map((n) => [n.id, n.name]));
        for (const e of esc) {
          await tx.insert(schema.leadActivity).values({
            leadId: e.leadId, workspaceId: w.id, type: "escalated", actorId: null,
            summary: `Escalated to managers after ${s.escalateAfterMin} min overdue`, data: { taskId: e.id }, idempotencyKey: `esc:${e.id}`,
          }).onConflictDoNothing();
          for (const m of managers) {
            await notify(tx, { workspaceId: w.id, memberId: m.id, kind: "escalation", title: `Escalation: ${nameOf.get(e.leadId) ?? "lead"}`, body: `Overdue more than ${s.escalateAfterMin} min`, leadId: e.leadId, taskId: e.id, dedupeKey: `esc:${e.id}:${m.id}` });
          }
        }
        out.escalated += esc.length;
      }
    });

    await deliverExternal(w.id, w.timezone, s, out);
  }
  return out;
}

/** Delivers queued external notifications. Rows are leased so two workers never send the same one. */
async function deliverExternal(workspaceId: string, tz: string, s: ReturnType<typeof readSettings>, out: SweepResult) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return; // no external channel configured: nothing is pending, nothing is claimed
  const now = new Date();
  if (inQuietHours(now, tz, s.quiet)) return;
  const claimed = await dbTx.execute(sql`
    update notification_delivery d set attempts = d.attempts + 1, next_attempt_at = now() + interval '5 minutes'
    where d.id in (
      select d2.id from notification_delivery d2 join notification n on n.id = d2.notification_id
      where d2.channel = 'webhook' and d2.status = 'pending' and d2.next_attempt_at <= now() and n.workspace_id = ${workspaceId}
      order by d2.next_attempt_at limit 50 for update of d2 skip locked)
    returning d.id, d.notification_id, d.attempts`);
  for (const row of claimed.rows as { id: string; notification_id: string; attempts: number }[]) {
    const [n] = await db.select().from(schema.notification).where(eq(schema.notification.id, row.notification_id));
    if (!n) continue;
    try {
      const body = JSON.stringify({ id: n.id, kind: n.kind, title: n.title, body: n.body, leadId: n.leadId, memberId: n.memberId, createdAt: n.createdAt });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (process.env.WEBHOOK_SECRET) headers["x-leadflow-signature"] = createHmac("sha256", process.env.WEBHOOK_SECRET).update(body).digest("hex");
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await db.update(schema.notificationDelivery).set({ status: "sent", sentAt: new Date(), lastError: null }).where(eq(schema.notificationDelivery.id, row.id));
      out.delivered++;
    } catch (e) {
      const failed = row.attempts >= MAX_DELIVERY_ATTEMPTS;
      const backoff = Math.min(2 ** row.attempts * MIN, 6 * 3_600_000);
      await db.update(schema.notificationDelivery).set({
        status: failed ? "failed" : "pending", lastError: (e as Error).message.slice(0, 300), nextAttemptAt: new Date(Date.now() + backoff),
      }).where(eq(schema.notificationDelivery.id, row.id));
      if (failed) out.failed++;
    }
  }
}

/** Opportunistic sweep for logged-in traffic, throttled to once a minute per workspace. Does not replace a real worker. */
export function sweepSoon(workspaceId: string) {
  after(async () => {
    try {
      const claimed = await db.update(schema.workspace)
        .set({ settings: sql`jsonb_set(coalesce(${schema.workspace.settings}, '{}'::jsonb), '{lastSweepAt}', to_jsonb(now()::text))` })
        .where(and(eq(schema.workspace.id, workspaceId),
          sql`((settings->>'lastSweepAt') is null or (settings->>'lastSweepAt')::timestamptz < now() - interval '60 seconds')`))
        .returning({ id: schema.workspace.id });
      if (claimed.length) await sweep(workspaceId);
    } catch (e) {
      console.error("sweepSoon failed", e);
    }
  });
}

