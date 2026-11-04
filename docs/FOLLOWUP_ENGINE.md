# Follow-up engine

## Model
- `lead.status` is the lifecycle stage. `lead.follow_up_step` is the step of the open task (or `completed`).
  `follow_up_task.channel` and `.outcome` record how and with what result a contact ended. These four are separate fields.
- A lead has **at most one open task**, enforced by a partial unique index (`task_one_pending_uq`).
- Tasks are never deleted or edited into a different meaning. A task ends as `completed`, `rescheduled` or `cancelled`, and a new row is created for the next one.

## Scheduling (`src/lib/schedule.ts`)
Sequence: first contact, 24H, 48H, final, then `completed`.
Intervals are settings (hours after the **first recorded contact**): defaults 24 / 48 / 72. They are anchored to the real event, not to when a task was closed.
A task is never created already overdue: it is floored at now + `minGapMin`.
- **No answer**: the task stays open, retried after `retryNoAnswerMin` (240). After `maxNoAnswer` (3) tries the sequence moves on. A lead is **never** closed or marked No Response automatically.
- **Spoke to lead / Interested**: completes the task, schedules the next step.
- **Callback requested**: completes the task and creates a new one for the same step at the requested time.
- **Converted / Not interested / Dropped**: closes the lead and cancels the open task.
- After the final step the lead stays open as **Needs decision**.

## State transitions (`src/lib/engine.ts`)
Every transition runs in one database transaction, locks the lead row (`SELECT ... FOR UPDATE`), and checks an idempotency key stored in `lead_activity`.
Repeating a request with the same key changes nothing. Two people acting at once are serialized.

## Overdue
Overdue is computed from `due_at < now()` everywhere (queues, dashboard, badges). It does not need a worker.
The worker only records history and sends things: `first_missed_at`, a `followup_missed` timeline entry, notifications, escalation.

## Worker (`src/lib/sweep.ts`, `POST /api/worker/tick`)
Protected by `Authorization: Bearer $CRON_SECRET`. Idempotent: unique keys and conditional updates mean repeats do nothing.
Per pass: record missed deadlines, create due / overdue / advance reminders, escalate to managers after `escalateAfterMin`, deliver queued external messages.
Triggers that exist: Vercel Cron (daily on the free plan), `.github/workflows/worker-tick.yml` (every 5 minutes, needs two repo secrets), and an opportunistic throttled pass when someone opens the app.
Any other scheduler can call the same URL every minute.

## Notifications and delivery
`notification` is the alert. `notification_delivery` has one row per channel.
- **in_app**: stored as sent, because the alert row is what the app shows.
- **webhook** (only when `WEBHOOK_URL` is set): starts `pending`, becomes `sent` only after a real 2xx. Failures back off exponentially and end as `failed` after 6 tries. Quiet hours defer delivery.
With no webhook configured, no external delivery row is created, and the UI never claims one was sent.

## Environment
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CRON_SECRET`, `OWNER_EMAIL`, `SETUP_TOKEN` (first-admin bootstrap only), optional `WEBHOOK_URL`, `WEBHOOK_SECRET`.
