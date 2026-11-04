# MASTER BUILD PROMPT — LEADFLOW
## Premium Mobile-First Lead Operations CRM with Google Sheets Synchronization, Team Management, Intelligent Follow-ups & AI Insights

You are acting as a senior full-stack engineer, product architect, UI/UX designer, and CRM workflow specialist.

Your task is to **design and implement a complete, production-ready lead management and short-term follow-up application**, not a static dashboard or frontend-only demonstration.

The platform must be beautiful, fast, secure, genuinely useful for everyday sales operations, and equally professional on mobile and desktop.

**Primary mission: No lead should be forgotten, no scheduled follow-up should be missed without visibility, and managers must always know what is happening across their team.**

## 1. INSPECT THE EXISTING PROJECT FIRST

Before writing code:

1. Inspect the complete existing repository, frontend architecture, backend, database, authentication, components, design system, and integrations.
2. Identify existing reusable features and services.
3. Inspect the supplied Google Spreadsheet and its complete structure, once authorized.
4. Read all relevant worksheets, column headings, grouped sections, data validation values, formulas, protected ranges, and existing workflow fields.
5. Determine which tabs contain actual leads versus summary tables, dropdown options, reference data, or other information.
6. Identify inconsistencies, duplicate information, incomplete records, and opportunities for improvement.
7. Produce a concise implementation plan and field-mapping report.
8. Then proceed with implementation.

**Google Spreadsheet:**

https://docs.google.com/spreadsheets/d/1l4jCxAY_vZXdb-MejHX2dc-VfOHp2906LuaX45NV6Kw/edit?gid=1316863377#gid=1316863377

Spreadsheet ID:
`1l4jCxAY_vZXdb-MejHX2dc-VfOHp2906LuaX45NV6Kw`

Initial worksheet GID:
`1316863377`

IMPORTANT:

- Do not assume the spreadsheet has only one worksheet.
- Do not invent its actual column names or data.
- Do not overwrite, delete, restructure, or alter the original spreadsheet without explicit authorization.
- If access is unavailable, build the Google OAuth connection and schema discovery workflow first.
- Continue building the application without fabricating imported records.
- Preserve existing project functionality and conventions.

## 2. CORE PRODUCT PHILOSOPHY

This is not intended to be a complicated enterprise CRM.

It is a **short-term, daily-use lead operations system**.

Most activity should revolve around:

- New leads arriving today.
- Leads received yesterday.
- Unassigned leads.
- First contacts.
- Follow-ups due now or today.
- Follow-ups scheduled within 24 and 48 hours.
- Final follow-up attempts.
- Conversions and activation milestones.
- Leads with no response.
- Leads explicitly closed or dropped.
- Team productivity and manager oversight.

Avoid unnecessary long-term sales forecasting modules or large CRM interfaces that slow down daily work.

Prioritize minimal actions, clear information, and extremely fast workflows.

## 3. DESIGN SYSTEM — PREMIUM UI/UX

Create an original, elegant, modern design using restrained **glassmorphism and soft premium surfaces**.

Design direction:

- Contemporary SaaS aesthetic.
- Light mode as a polished default, with a carefully designed dark mode.
- Soft translucent surfaces and subtle backdrop blur where appropriate.
- Refined rounded corners.
- Excellent spacing and alignment.
- Clean typography and legible information density.
- Professional, coherent Lucide icons.
- Extremely subtle shadows and borders.
- Minimal visual noise.
- Meaningful semantic colors for statuses.
- Lightweight animations and transitions.
- No excessive gradients or artificial-looking decoration.
- No text-heavy cards or unnecessary long descriptions.
- No generic admin-dashboard appearance.

Use charts, icons, progress indicators, and microvisualizations where they genuinely communicate information more effectively than text.

Glass effects must never reduce readability, contrast, or performance.

### Mobile-first requirement

Build for mobile first, but give desktop equal attention in quality and functionality.

Mobile must have:

- Dedicated responsive layouts, not simply shrunken desktop tables.
- Fixed bottom navigation where appropriate.
- Comfortable touch targets, preferably at least 44×44 px.
- Sticky primary actions.
- Compact lead cards.
- Fast bottom sheets and action drawers.
- Single-tap communication actions.
- Swipe gestures only when accompanied by accessible alternatives.
- Readable text without horizontal scrolling.
- Safe-area support.
- Excellent performance on ordinary mobile devices.
- PWA support where practical.

Desktop must have:

- Elegant collapsible sidebar.
- Responsive dashboard grids.
- Powerful searchable and filterable lead table.
- Split-view lead details when useful.
- Multi-select and bulk actions.
- Keyboard shortcuts.
- Efficient layouts for managers handling large lead volumes.

Maintain complete feature parity across devices.

## 4. MAIN APPLICATION NAVIGATION

Organize the application into these core areas:

### A. Overview
The main command center.

### B. Leads
All leads, assigned leads, lead details, sources, activation progress, and outcomes.

### C. Follow-ups
Daily tasks, upcoming reminders, overdue cases, and completed activities.

### D. Team
BD assignments, team activity, workload, and performance.

### E. Insights
Operational analytics and AI-generated summaries.

### F. Integrations
Google Sheets connections, synchronization, mappings, and import history.

### G. Settings
Team roles, permissions, automation preferences, status definitions, and notifications.

On mobile, intelligently consolidate navigation into a small number of primary destinations without hiding important functions.

## 5. OVERVIEW DASHBOARD

Design an exceptional daily overview screen.

### Primary metrics

Display:

- New Leads Today
- New Leads Yesterday
- Percentage Change
- Total Active Leads
- Due Today
- Overdue Follow-ups
- Unassigned Leads
- Contacted Today
- Converted Today
- Leads Closed or Dropped

The most urgent metrics must be visually prominent.

All numbers must be computed using actual database records.

Allow clicking any metric to open the corresponding filtered leads.

### Daily operational briefing

Create a section titled **Today's Priorities**.

It should show actionable information such as:

- Fazal's overdue follow-ups.
- Power's pending follow-ups.
- Leads awaiting their first contact.
- Leads not assigned to a BD.
- Leads approaching their deadlines.
- Important changes in conversion or response rates.

All entries must show real counts when data exists, and link to the affected records.

### AI summary card

Add a compact AI assistant panel near the top.

Example output format:

"New leads increased compared with yesterday. Several follow-ups are overdue. Fazal has pending tasks, and Power has leads approaching their deadlines. Prioritize overdue leads and uncontacted new arrivals."

This is a formatting example only.

Real output must be grounded in actual records, with exact metrics generated deterministically.

Display the data freshness timestamp.

Provide quick actions:

- View Priority Leads
- View Overdue
- Review Team
- Refresh Summary

### Additional dashboard modules

- Recent Lead Activity
- Team Follow-up Distribution
- Lead Source Breakdown
- Seven-day Lead Volume
- Contact and Conversion Trends
- Recently Converted Leads
- Google Sheets Sync Status

Avoid filling the homepage with low-value graphs.

## 6. LEAD STATUS, FOLLOW-UP STEP & ACTIVATION PROGRESS

These represent separate concepts and must not be merged into one confusing field.

### Lead Status

Initial suggested values, subject to mapping against the actual spreadsheet:

- New
- Contacted
- Interested
- Proposal Sent
- Converted
- Not Interested
- No Response
- Cold

Allow administrators to configure the mapping without breaking historical records.

### Follow-up Step

- Contact Started
- 24H Follow-up
- 48H Follow-up
- Final Follow-up
- Completed

Track both the current step and actual scheduled next action.

### Activation milestones

Track independent milestones:

1. App Downloaded
2. Referral Code Shared
3. Card Purchased
4. Spending Started

These should appear as a clean icon-based progress component on the lead profile.

Do not assume all milestones are mandatory or must occur in an exact order unless configured.

Preserve original source values and map them into normalized fields.

### Optional final outcome details

Support:

- Converted
- Not Interested
- No Response
- Dropped
- Duplicate
- Invalid Lead
- Other

Prevent conflicting duplicate statuses by defining whether these are terminal outcomes or activity-level results.

Add optional closure reason and notes.

**Important:** A single unanswered call or message should not automatically close a lead as No Response.

## 7. FOLLOW-UP ENGINE — HIGHEST PRIORITY

This is the most important part of the entire product.

Build a real backend-driven task scheduling and reminder engine.

### Default short-term workflow

**Initial Contact**
- BD initiates conversation.
- Contact attempt is logged.
- Next follow-up can be scheduled.

**24-Hour Follow-up**
- Automatically create a reminder based on the configured rule.
- Surface the lead in the owner's queue.
- Allow marking as contacted, unanswered, rescheduled, or converted.

**48-Hour Follow-up**
- Schedule the second reminder when applicable.
- Escalate priority where appropriate.

**Final Follow-up**
- Prompt the BD for a final action or explicit decision.
- Allow completion, closure, or manual rescheduling.

**Completion**
- Store the final outcome, owner, and timestamp.
- Preserve the full activity history.

Use configurable intervals; 24 and 48 hours are the initial defaults.

Follow-up timing should be tied to recorded actions and explicit due dates, not inferred from the current dropdown value alone.

### Follow-up queues

Provide dedicated views:

- Due Now
- Due Today
- Overdue
- Upcoming
- Completed
- No Response
- Unassigned
- All Tasks

### Essential actions

- Contacted
- No Answer
- Interested
- Converted
- Reschedule
- Add Note
- Assign to BD
- Close Lead
- Reopen Lead

After every follow-up attempt, provide a simple compact action panel.

The user should complete the entire interaction in a few taps.

### Overdue protection

Never silently discard an overdue task.

Implement:

- Persistent overdue state.
- In-app notifications.
- Escalation to manager after configurable delay.
- Owner and backup owner visibility.
- Automatic inclusion in daily manager reports.
- Clear missed-follow-up history.
- Duplicate-reminder prevention.
- Task idempotency across repeated jobs.

A missed deadline should remain visible until resolved.

Do not automatically mark tasks as successfully completed.

### Notification rules

Support configurable:

- Due-time reminders.
- Optional advance reminder.
- Overdue alerts.
- Manager escalation.
- Daily team briefing.
- Notification quiet hours.
- User and workspace time zones.

Start with in-app notifications. Add browser/PWA push where supported and authorized.

Email or WhatsApp notification integrations should be optional extensions, not hardcoded dependencies.

## 8. LEAD MANAGEMENT

Build a complete lead list and lead profile.

### Suggested normalized lead fields

- Internal Lead ID
- External Source ID
- Google Spreadsheet ID
- Worksheet ID
- Source Record Identifier
- Lead Name
- Phone / WhatsApp
- Email, if available
- Source / Campaign
- Assigned BD
- Lead Status
- Follow-up Step
- Activation Milestones
- Created At
- First Contacted At
- Last Contacted At
- Next Follow-up At
- Follow-up Attempts
- Priority
- Last Interaction Result
- Notes
- Closure Reason
- Converted At
- Original Source Link
- Last Synced At
- Created By / Updated By
- Additional Custom Fields

Do not require fields the original source does not have unless essential to the workflow.

Preserve unmapped columns as custom fields when appropriate.

### Lead profile

Display a clean, compact detail screen containing:

- Contact information
- Lead status
- Assigned BD
- Activation progress
- Next follow-up
- Quick communication actions
- Notes
- Interaction timeline
- Source details
- Sync history when applicable

### Interaction timeline

Record meaningful events such as:

- Lead created or imported.
- Assigned to Fazal.
- Status updated.
- WhatsApp contact attempted.
- Follow-up completed.
- Note added.
- Assigned to another BD.
- Converted.
- Closed or reopened.

Every event should include timestamp and actor.

External WhatsApp/call links do not themselves prove contact occurred. Require an explicit activity confirmation unless a verified provider integration supplies the event.

### Deduplication

Detect likely duplicates using normalized contact identifiers and other appropriate signals.

Preserve the original phone number formatting.

Do not merge two people automatically merely because of similar names.

Provide an admin-controlled merge workflow with a visible audit trail.

## 9. TEAM & BD MANAGEMENT

Implement three primary roles:

**Admin**
- All features.
- Integration management.
- Team management.
- Global settings.
- All lead access.

**Manager**
- View and assign team leads.
- Monitor deadlines.
- Review performance.
- Reassign work.
- View insights and audit history.

**BD / Sales Representative**
- View permitted assigned leads.
- Perform follow-ups.
- Update statuses and notes.
- Review personal metrics.
- Manage their own permitted tasks.

Support configurable visibility and an optional read-only role.

### Assignments

Allow:

- Manual assignment.
- Bulk assignment.
- Optional round-robin distribution.
- Capacity-aware distribution if enabled.
- Reassignment with a reason.
- Backup owner assignment.
- Immediate highlighting of unassigned leads.

Do not auto-assign silently unless the workspace enables automation.

### Team dashboard

Each BD card should show:

- Total assigned
- New leads today
- Follow-ups due
- Overdue follow-ups
- Contacted today
- Converted
- Follow-up completion rate

Support viewing individual performance and drilling down into the relevant records.

Do not use misleading rankings based only on assigned lead count.

## 10. GOOGLE SHEETS INTEGRATION

Build a real Google Sheets integration.

### Connection

- Google OAuth authentication.
- Explicit workspace authorization.
- Connect an existing spreadsheet by URL or picker.
- Discover all available worksheets.
- Select which tabs to import.
- Preview headers and sample records.
- Map source columns to application fields.
- Save mapping per worksheet.
- Show permissions and connection health.

Use minimum necessary OAuth scopes and encrypted token storage.

### Synchronization

Support:

- Initial full import.
- Scheduled incremental reconciliation.
- Event-assisted refresh using supported Google Drive change notifications.
- Manual Sync Now action.
- Reconnection after authentication expiration.
- Sync history and errors.
- Retries with exponential backoff.
- API rate-limit handling.
- Channel expiration management and renewal.
- Automatic recovery from temporary outages.

Google Drive change notifications signal that a file changed; fetch the current sheet values separately.

Use periodic reconciliation as a reliability fallback.

Do not depend solely on Google Apps Script `onEdit` triggers, which do not fire for all API-generated edits.

### New lead ingestion

When a new valid record is added to a connected worksheet:

1. Detect it.
2. Validate and normalize fields.
3. Identify its source.
4. Check for an existing lead.
5. Create or update the appropriate database record.
6. Record the import event.
7. Make it visible to the appropriate BD/manager.
8. Generate assignment or first-contact tasks according to workspace rules.
9. Update dashboard metrics.

Handle multiple new records arriving in one synchronization cycle.

### Important row identity requirement

Never use a Google Sheet row number as the permanent unique identity of a lead.

Rows may be sorted, inserted, deleted, or moved.

Prefer a persistent external lead identifier when available.

If unavailable, propose a stable identifier strategy with explicit consent before writing any new ID column to the spreadsheet.

Use safe matching rules and surface ambiguity instead of creating duplicate or merged records silently.

### Data ownership and synchronization modes

Provide:

**Read-only mode**
- Google Sheets feeds new data into the application.
- CRM follow-up data stays in the application database.

**Optional two-way mode**
- Approved application fields can be synchronized back to designated spreadsheet columns.
- Show a mapping preview before enabling.
- Never overwrite formulas or protected cells.
- Implement conflict detection and a resolution workflow.
- Prevent synchronization loops.

Recommend read-only import as the initial safe default.

### Data integrity

- Do not delete leads automatically because a source row disappears.
- Do not let sheet edits erase activity history.
- Maintain source provenance and update timestamps.
- Avoid overwriting newer CRM-owned follow-up information with stale sheet data.
- Preserve a record of synchronization failures.
- Display last successful sync and stale connection warnings.

Support connecting multiple spreadsheets in the future through a reusable integration architecture.

## 11. AI INSIGHTS & DAILY SUMMARIES

Integrate an optional AI assistant with controlled access to authorized workspace data.

AI should interpret verified records, not invent statistics.

### Daily summary

Generate an operational briefing covering:

- Today's lead count.
- Comparison with yesterday.
- Follow-ups due and overdue.
- High-priority uncontacted leads.
- BD workload.
- Conversion and activation progress.
- Leads requiring management attention.
- Recommended immediate next actions.

### AI questions

Support natural language requests such as:

- "How many new leads arrived today?"
- "What is Fazal's pending follow-up count?"
- "Show Power's overdue leads."
- "Which BD has the most overdue tasks?"
- "Which leads have received no response?"
- "How many leads started spending?"
- "Summarize the team's activity today."
- "Which leads need attention first?"

The assistant must use role-scoped database queries.

Show supporting records or clickable filtered views wherever feasible.

Counts and calculations must be produced by deterministic queries, not estimated by the language model.

### AI safeguards

- Clearly identify the reporting period.
- Respect user permissions.
- Minimize personal information sent to model providers.
- Do not fabricate notes or conversations.
- Do not claim that a lead was contacted without evidence.
- Make AI features configurable and optional.
- Keep basic analytics fully functional without AI.

## 12. INSIGHTS & REPORTING

Keep reporting focused on daily and recent operational performance.

Build:

- Today vs Yesterday
- Last Seven Days
- Optional Fourteen-Day View
- Team Comparison
- Lead Source Analysis
- Contact Rate
- Follow-up Completion Rate
- Overdue Rate
- Conversion Rate
- Activation Milestone Progression
- Dropped Lead Reasons

Each metric requires a clear definition.

Use the source's genuine creation date where available. Do not count every imported historical record as a newly acquired lead.

Distinguish acquisition time, import time, and follow-up activity time.

Support filters by BD, source, date, status, and campaign.

Allow exports for authorized users.

## 13. MOBILE WORKFLOW

Build a dedicated optimized mobile experience.

A BD opening the application on their phone should immediately see:

1. Their outstanding work.
2. The most urgent follow-up.
3. The next lead requiring action.
4. Contact shortcuts.
5. A one-tap result update.
6. Their progress for today.

The main interaction should be:

Open application → Select due lead → Contact → Log result → Schedule next action → Next lead.

Minimize typing, page transitions, popups, and repeated selections.

Use quick chips, contextual defaults, and prefilled follow-up intervals.

For managers, mobile should include a compact team overview and urgent escalation queue.

## 14. DATA ARCHITECTURE

Use the existing repository's stack and design system when practical.

If starting from a new project, choose a modern maintainable TypeScript-based full-stack architecture with a relational database and reliable background processing.

Suggested data entities:

- Workspace
- User
- WorkspaceMember
- Lead
- LeadSource
- SpreadsheetConnection
- WorksheetMapping
- LeadAssignment
- LeadActivity
- FollowUpTask
- Reminder
- Notification
- ActivationMilestone
- LeadOutcome
- SyncJob
- SyncCheckpoint
- SyncConflict
- AuditLog
- AIInsight

Implement database indexes, migrations, validation, and appropriate access controls.

Use UTC for stored instants and configurable workspace time zones for presentation and daily reporting.

Default timezone can be Asia/Karachi.

### Reliability rules

- All important writes must persist.
- Prevent duplicate ingestion.
- Prevent duplicate scheduled tasks.
- Prevent duplicated activity records on retries.
- Handle concurrent updates safely.
- Use transactional state transitions where necessary.
- No accidental data loss.
- No fake success messages.
- No secrets in frontend bundles.
- No unnecessary API exposure.
- Secure all endpoints and sensitive data access.

## 15. PRODUCT QUALITY & PERFORMANCE

Deliver a fast, professional product.

Requirements:

- Smooth navigation.
- Responsive rendering.
- Efficient database queries.
- Appropriate list virtualization or pagination.
- Clear loading, empty, disconnected, and error states.
- Accessible components.
- WCAG 2.2 AA-oriented design.
- Proper keyboard navigation.
- Good contrast.
- No layout overflow.
- Correct mobile safe areas.
- Reliable session management.
- Minimal unnecessary API traffic.
- Useful error recovery.
- Optimistic updates only with proper rollback.

The UI must work well at small mobile widths, tablet sizes, and wide desktop screens.

Use real persisted application data. Demo records, if used during development, must be explicitly isolated from production data.

## 16. TESTING REQUIREMENTS

Test the following:

- Connecting Google Sheets.
- Discovering multiple worksheets.
- Mapping columns accurately.
- Importing historical records.
- Detecting newly added records.
- Handling changed or reordered rows.
- Deduplicating records.
- Synchronizing safely after failures.
- Preventing unauthorized modifications.
- Assigning leads to BDs.
- Completing and rescheduling follow-ups.
- Keeping overdue tasks visible.
- Escalating missed follow-ups.
- Avoiding duplicate reminders.
- Handling simultaneous manager and BD edits.
- Correct daily counts around timezone boundaries.
- Role-based permissions.
- AI responses grounded in real data.
- Mobile workflow usability.
- Desktop table and filtering functionality.

Test representative screen widths of 360px, 390px, 768px, 1024px, and 1440px.

Use unit tests, integration tests, and relevant end-to-end tests.

Fix actual problems instead of only documenting them.

## 17. IMPLEMENTATION ORDER

Work in logical production-ready phases:

**Phase 1 — Audit & Architecture**
- Inspect repository and spreadsheet.
- Identify reusable infrastructure.
- Document mappings and core requirements.
- Define database and synchronization ownership.

**Phase 2 — Core CRM**
- Authentication and permissions.
- Lead database.
- Lead lists and profiles.
- BD assignment.
- Statuses, milestones, and activity timeline.

**Phase 3 — Follow-up Engine**
- Task scheduling.
- Daily queues.
- Overdue detection.
- Notifications.
- Escalations.
- Completion and closure workflows.

**Phase 4 — Google Sheets Integration**
- OAuth connection.
- Worksheet discovery.
- Mapping and import.
- Incremental synchronization.
- Error handling.
- Optional two-way mode.

**Phase 5 — Premium Interfaces**
- Mobile dashboard.
- Desktop dashboard.
- Team views.
- Follow-up workspace.
- Responsive reporting.

**Phase 6 — AI & Analytics**
- Operational metrics.
- Daily summary.
- AI queries.
- Management insights.

**Phase 7 — Verification**
- End-to-end testing.
- Security checks.
- Performance optimization.
- Responsive visual review.
- Final documentation.

Build and validate real functionality throughout; do not leave the backend until the end.

## 18. ACCEPTANCE CRITERIA

The application is complete only when:

1. An authorized user can connect a Google Sheet and inspect/select its worksheets.
2. The application imports actual leads using a confirmed mapping.
3. Newly added source records are detected and ingested reliably.
4. Managers can assign leads to team members.
5. Every BD has a personal daily follow-up queue.
6. Completed activities and notes persist correctly.
7. Overdue follow-ups remain visible until resolved.
8. Managers can identify missed tasks and their owners.
9. The dashboard accurately compares today and yesterday.
10. Lead statuses, follow-up steps, activation milestones, and final outcomes are distinguishable.
11. Google Sheets synchronization failures are visible and recoverable.
12. The AI assistant can summarize authorized real operational data without fabricated claims.
13. Mobile and desktop interfaces are polished and fully usable.
14. The complete application is functional, tested, secure, and deployable.

## FINAL DEVELOPMENT INSTRUCTION

Start by inspecting the repository and available authorized spreadsheet data.

Do not simply generate HTML previews, decorative dashboards, or mock interfaces.

Implement the actual operational application end to end.

Make sensible decisions using the established requirements, document any assumptions, and preserve existing project features.

If spreadsheet authorization or external credentials are unavailable, implement the functional connection and onboarding workflow, clearly report the blocker, and continue independent development.

Prioritize in this order:

**Follow-up reliability → Data integrity → Mobile usability → Team accountability → Google Sheets synchronization → Premium design → AI enhancements.**

Every design decision should help the team manage leads faster, with less effort and fewer missed opportunities.
