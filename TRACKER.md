# LeadFlow — Progress Tracker

Spec: [MASTER_PROMPT.md](MASTER_PROMPT.md) (source of truth, do not edit)
Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

## Stack decisions

| Area | Choice | Status |
|---|---|---|
| Hosting | Vercel **or** Netlify | [ ] decide |
| Database | Supabase **or** Neon (Postgres) | [ ] decide |
| Source control | GitHub | [ ] repo created |
| Language | TypeScript full-stack | [ ] confirm framework (suggested: Next.js + Drizzle/Prisma) |
| Background jobs | Vercel Cron / Netlify Scheduled Functions / pg_cron | [ ] decide |
| Auth | Supabase Auth / Neon Auth / Auth.js | [ ] decide |

Notes
- Priority order: Follow-up reliability → Data integrity → Mobile usability → Team accountability → Sheets sync → Premium design → AI.
- Default timezone: Asia/Karachi. Store UTC.
- Sheets mode default: read-only import. Never write to the sheet without explicit approval.
- Serverless caveat: sync and reminder jobs must be idempotent and short; use cron + DB-backed job table (no in-memory schedulers).

## Open blockers / decisions needed

- [ ] Google OAuth credentials (client ID/secret) + consent screen
- [ ] Sheet access: share with the OAuth account, or provide service account
- [ ] Pick hosting + DB (see table above)
- [ ] Confirm BD names / roles (Fazal, Power, others?)

## Phase 1 — Audit & Architecture
- [ ] Inspect repo (currently empty, not a git repo)
- [ ] Inspect spreadsheet: all tabs, headers, validations, formulas, protected ranges
- [ ] Classify tabs: leads vs summary vs reference
- [ ] Field-mapping report
- [ ] Row-identity strategy (no row numbers as identity)
- [ ] Data ownership / sync rules documented
- [ ] DB schema + ERD
- [ ] Implementation plan

## Phase 2 — Core CRM
- [ ] Project scaffold, CI, env handling
- [ ] Auth + roles (Admin / Manager / BD / read-only)
- [ ] Migrations + indexes
- [ ] Lead table, list, filters, search, pagination
- [ ] Lead profile (contact, status, milestones, timeline)
- [ ] Lead status / follow-up step / milestones / outcomes as separate fields
- [ ] Assignment: manual, bulk, reassign w/ reason, backup owner
- [ ] Activity timeline + audit log
- [ ] Dedup detection + admin merge workflow

## Phase 3 — Follow-up Engine (highest priority)
- [ ] FollowUpTask + Reminder model, idempotency keys
- [ ] Configurable intervals (24h / 48h / final)
- [ ] Queues: Due Now, Today, Overdue, Upcoming, Completed, No Response, Unassigned, All
- [ ] Actions: Contacted, No Answer, Interested, Converted, Reschedule, Note, Assign, Close, Reopen
- [ ] Persistent overdue state + missed history
- [ ] In-app notifications
- [ ] Manager escalation after delay
- [ ] Quiet hours + timezones
- [ ] Daily manager report
- [ ] Duplicate-reminder prevention tests
- [ ] PWA push (optional)

## Phase 4 — Google Sheets Integration
- [ ] OAuth (minimum scopes) + encrypted token storage
- [ ] Connect by URL/picker, discover worksheets
- [ ] Preview headers/sample rows, column mapping per tab
- [ ] Initial full import
- [ ] Scheduled incremental reconciliation
- [ ] Drive change notifications + channel renewal
- [ ] Sync Now, retries/backoff, rate-limit handling
- [ ] Sync history + visible errors + reconnect flow
- [ ] Conflict detection (SyncConflict)
- [ ] Optional two-way mode (with preview, loop prevention)

## Phase 5 — Premium Interfaces
- [ ] Design tokens, light + dark, glass surfaces
- [ ] Mobile: bottom nav, due-lead flow, bottom sheets, safe areas
- [ ] Desktop: collapsible sidebar, table, split view, shortcuts, bulk actions
- [ ] Overview dashboard + Today's Priorities
- [ ] Team views
- [ ] Follow-up workspace
- [ ] PWA manifest + service worker

## Phase 6 — AI & Analytics
- [ ] Metric definitions + deterministic queries
- [ ] Today vs Yesterday, 7/14 day views
- [ ] Insights page + filters + export
- [ ] Daily summary (grounded)
- [ ] NL questions via role-scoped queries
- [ ] AI safeguards + on/off setting

## Phase 7 — Verification
- [ ] Unit + integration tests
- [ ] E2E tests
- [ ] Timezone boundary tests
- [ ] Permission tests
- [ ] Responsive review at 360 / 390 / 768 / 1024 / 1440
- [ ] Security review (secrets, endpoints, RLS/authz)
- [ ] Performance pass
- [ ] Docs + deploy

## Acceptance criteria (from spec §18)
- [ ] 1 Connect sheet and select worksheets
- [ ] 2 Import real leads via confirmed mapping
- [ ] 3 New rows detected and ingested reliably
- [ ] 4 Managers assign leads
- [ ] 5 Per-BD daily queue
- [ ] 6 Activities and notes persist
- [ ] 7 Overdue stays visible until resolved
- [ ] 8 Missed tasks and owners identifiable
- [ ] 9 Today vs yesterday accurate
- [ ] 10 Status / step / milestones / outcome distinct
- [ ] 11 Sync failures visible and recoverable
- [ ] 12 AI summary grounded in real data
- [ ] 13 Mobile and desktop polished
- [ ] 14 Functional, tested, secure, deployable

## Log

| Date | Update |
|---|---|
| 2026-11-04 | Spec saved; tracker created. Nothing built yet. |
