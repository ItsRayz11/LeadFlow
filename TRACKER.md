# LeadFlow — Progress Tracker

Spec: [MASTER_PROMPT.md](MASTER_PROMPT.md) (source of truth, do not edit)
Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

## Stack decisions

| Area | Choice | Status |
|---|---|---|
| Hosting | Vercel (leadflow-five-beta.vercel.app), auto-deploy on push | [x] live |
| Database | Neon Postgres, project `leadflow` (super-firefly-90437398, aws-ap-southeast-1) | [x] created, schema migrated |
| Source control | GitHub ItsRayz11/LeadFlow (public) | [x] |
| Language | TypeScript full-stack | [x] Next.js + Drizzle in app/ |
| Background jobs | Vercel Cron / Netlify Scheduled Functions / pg_cron | [ ] decide |
| Auth | Better Auth (tables in schema) | [~] tables ready, wiring pending |

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
- [x] DB schema (src/db/schema.ts, migration 0000 applied)
- [ ] Implementation plan

## Phase 2 — Core CRM
- [x] Project scaffold + env handling (CI pending)
- [x] Auth + roles: Better Auth; first-admin bootstrap needs OWNER_EMAIL + SETUP_TOKEN; invite-only after; invitations, revoke, deactivate, roles built
- [x] Migrations + indexes
- [~] Lead list with segments + search (real DB); pagination/filters by owner & source pending
- [x] Lead profile interactive: edit, assign, stage, contact log, notes, milestones, close/reopen, timeline
- [ ] Lead status / follow-up step / milestones / outcomes as separate fields
- [~] Assignment: manual, bulk, reassign with reason done; backup owner pending
- [x] Activity timeline + audit log
- [ ] Dedup detection + admin merge workflow

## Phase 3 — Follow-up Engine (highest priority)
- [x] FollowUpTask + Reminder model, idempotency keys
- [x] Configurable intervals (24h / 48h / final)
- [x] Queues: Due Now, Today, Overdue, Upcoming, Completed, No Response, Unassigned, All
- [x] Actions: Contacted, No Answer, Interested, Converted, Reschedule, Note, Assign, Close, Reopen
- [x] Persistent overdue state + missed history
- [x] In-app notifications
- [x] Manager escalation after delay
- [~] Quiet hours + timezones (settings and delivery deferral done; per-user zones pending)
- [~] Daily manager report (team page shows overdue by owner; scheduled report pending)
- [x] Duplicate-reminder prevention tests
- [ ] PWA push (optional): webhook channel exists as the pluggable external path

## Phase 4 — Google Sheets Integration
- [ ] OAuth (minimum scopes) + encrypted token storage
- [x] Connect by URL (single tab via gid). Worksheet picker needs OAuth
- [~] Default column mapping per tab, confirm step. No header/sample preview or mapping editor yet
- [x] Initial full import (staging-tested; real sheet not yet imported)
- [x] Incremental reconciliation runs inside the worker tick (daily on Vercel Cron, 5-minute best effort via GitHub Actions)
- [ ] Drive change notifications + channel renewal
- [x] Sync Now, retries with exponential backoff on 429/5xx
- [~] Sync history + visible errors done. Reconnect flow needs OAuth
- [~] Unmapped owner names and possible duplicates are surfaced. No field-conflict resolution yet (read-only mode)
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
- [x] Unit + integration tests (15 unit, 7 DB integration)
- [x] E2E tests (31 flow + 50 responsive, Playwright, staging branch)
- [x] Timezone boundary tests
- [x] Permission tests
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
| 2026-11-04 | Spec saved; tracker created. |
| 2026-11-04 | Next.js scaffold, Neon project + full schema migrated, local git commit. GitHub remote creation was blocked, awaiting user. |
| 2026-11-04 | Pushed to GitHub, Vercel root=app, env vars set, auto-deploy on. Added login, workspace bootstrap, overview metrics, lead list, add-lead with duplicate check, lead profile (read-only). |
| 2026-11-04 | Phase 3 follow-up engine, follow-up dashboard, invitations and team, worker, interactive lead page. Tests green on staging. |
| 2026-11-04 | Production rollout: backup branch pre-rollout-20261104, migrations 0002 and 0003 applied and schema matched to staging, OWNER_EMAIL and SETUP_TOKEN set, deployed, unauthenticated checks passed, GitHub scheduler verified by manual run. Owner account not yet created. Next: owner registers at /setup, then Google Sheets integration. |
| 2026-11-09 | Phase 4 slice: read-only sheet import via link-sharing CSV export (no OAuth yet), identity by the sheet's `id` column, owner-name aliases, possible-duplicate flagging, Integrations page, sync in worker tick. 9 unit + 8 staging DB tests pass. Owner account still not registered; Google OAuth credentials still needed for private sheets, picker, Drive push and two-way. |
