import { sql } from "drizzle-orm";
import {
  boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

/* ---------- Better Auth tables ---------- */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/* ---------- Enums ---------- */
export const roleEnum = pgEnum("member_role", ["admin", "manager", "bd", "viewer"]);
export const leadStatusEnum = pgEnum("lead_status", [
  "new", "contacted", "interested", "proposal_sent", "converted", "not_interested", "no_response", "cold",
]);
export const followUpStepEnum = pgEnum("follow_up_step", [
  "contact_started", "h24", "h48", "final", "completed",
]);
// Terminal outcome: set only when a lead is closed. Separate from status & activity results.
export const outcomeEnum = pgEnum("lead_outcome", [
  "converted", "not_interested", "no_response", "dropped", "duplicate", "invalid", "other",
]);
export const taskStatusEnum = pgEnum("task_status", ["pending", "completed", "rescheduled", "cancelled"]);
export const activityTypeEnum = pgEnum("activity_type", [
  "imported", "created", "assigned", "status_changed", "contact_attempt", "contacted", "no_answer",
  "note", "followup_completed", "followup_rescheduled", "milestone", "closed", "reopened",
  "escalated", "merged", "synced",
]);
export const priorityEnum = pgEnum("priority", ["low", "normal", "high", "urgent"]);
export const syncModeEnum = pgEnum("sync_mode", ["read_only", "two_way"]);
export const syncStatusEnum = pgEnum("sync_status", ["running", "success", "partial", "failed"]);

/* ---------- Workspace & members ---------- */
export const workspace = pgTable("workspace", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Karachi"),
  // { h24, h48, escalateAfterMinutes, advanceReminderMinutes, quietHours, autoAssign }
  settings: jsonb("settings").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const workspaceMember = pgTable("workspace_member", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspace.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull().default("bd"),
  displayName: text("display_name").notNull(),
  active: boolean("active").notNull().default(true),
  capacity: integer("capacity"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("wm_ws_user_uq").on(t.workspaceId, t.userId)]);

/* ---------- Sheets integration ---------- */
export const spreadsheetConnection = pgTable("spreadsheet_connection", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspace.id, { onDelete: "cascade" }),
  spreadsheetId: text("spreadsheet_id").notNull(),
  title: text("title"),
  mode: syncModeEnum("mode").notNull().default("read_only"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  googleEmail: text("google_email"),
  healthy: boolean("healthy").notNull().default(true),
  lastError: text("last_error"),
  lastSuccessfulSyncAt: ts("last_successful_sync_at"),
  driveChannelId: text("drive_channel_id"),
  driveChannelResourceId: text("drive_channel_resource_id"),
  driveChannelExpiresAt: ts("drive_channel_expires_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("sc_ws_sheet_uq").on(t.workspaceId, t.spreadsheetId)]);

export const worksheetMapping = pgTable("worksheet_mapping", {
  id: id(),
  connectionId: uuid("connection_id").notNull().references(() => spreadsheetConnection.id, { onDelete: "cascade" }),
  sheetGid: text("sheet_gid").notNull(),
  sheetTitle: text("sheet_title").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  headerRow: integer("header_row").notNull().default(1),
  columnMap: jsonb("column_map").notNull().default({}),
  valueMaps: jsonb("value_maps").notNull().default({}),
  identityStrategy: text("identity_strategy").notNull().default("pending"),
  confirmedAt: ts("confirmed_at"),
}, (t) => [uniqueIndex("wsm_conn_gid_uq").on(t.connectionId, t.sheetGid)]);

export const syncJob = pgTable("sync_job", {
  id: id(),
  connectionId: uuid("connection_id").notNull().references(() => spreadsheetConnection.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull(), // manual | cron | drive_push | initial
  status: syncStatusEnum("status").notNull().default("running"),
  rowsSeen: integer("rows_seen").notNull().default(0),
  rowsCreated: integer("rows_created").notNull().default(0),
  rowsUpdated: integer("rows_updated").notNull().default(0),
  rowsSkipped: integer("rows_skipped").notNull().default(0),
  error: text("error"),
  attempt: integer("attempt").notNull().default(1),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
}, (t) => [index("sync_job_conn_idx").on(t.connectionId, t.startedAt)]);

export const syncConflict = pgTable("sync_conflict", {
  id: id(),
  connectionId: uuid("connection_id").notNull().references(() => spreadsheetConnection.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id"),
  field: text("field").notNull(),
  sheetValue: text("sheet_value"),
  crmValue: text("crm_value"),
  resolvedAt: ts("resolved_at"),
  resolution: text("resolution"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/* ---------- Leads ---------- */
export const lead = pgTable("lead", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspace.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phoneRaw: text("phone_raw"), // original formatting preserved
  phoneNorm: text("phone_norm"), // normalized for dedup
  email: text("email"),
  emailNorm: text("email_norm"),
  source: text("source"),
  campaign: text("campaign"),
  status: leadStatusEnum("status").notNull().default("new"),
  followUpStep: followUpStepEnum("follow_up_step").notNull().default("contact_started"),
  outcome: outcomeEnum("outcome"), // set only when closed
  closureReason: text("closure_reason"),
  closedAt: ts("closed_at"),
  priority: priorityEnum("priority").notNull().default("normal"),
  ownerId: uuid("owner_id").references(() => workspaceMember.id, { onDelete: "set null" }),
  backupOwnerId: uuid("backup_owner_id").references(() => workspaceMember.id, { onDelete: "set null" }),
  // Activation milestones: independent nullable timestamps
  appDownloadedAt: ts("app_downloaded_at"),
  referralSharedAt: ts("referral_shared_at"),
  cardPurchasedAt: ts("card_purchased_at"),
  spendingStartedAt: ts("spending_started_at"),
  // Distinct clocks: acquisition vs import vs activity
  acquiredAt: ts("acquired_at").notNull(),
  importedAt: ts("imported_at").notNull().defaultNow(),
  firstContactedAt: ts("first_contacted_at"),
  lastContactedAt: ts("last_contacted_at"),
  nextFollowUpAt: ts("next_follow_up_at"),
  followUpAttempts: integer("follow_up_attempts").notNull().default(0),
  lastResult: text("last_result"),
  convertedAt: ts("converted_at"),
  // Source provenance (never a row number as identity)
  connectionId: uuid("connection_id").references(() => spreadsheetConnection.id, { onDelete: "set null" }),
  sheetGid: text("sheet_gid"),
  externalId: text("external_id"),
  sourceRowHash: text("source_row_hash"),
  sourceUrl: text("source_url"),
  sourceRaw: jsonb("source_raw"),
  custom: jsonb("custom").notNull().default({}),
  lastSyncedAt: ts("last_synced_at"),
  mergedIntoId: uuid("merged_into_id"),
  version: integer("version").notNull().default(1), // optimistic concurrency
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("lead_source_uq").on(t.connectionId, t.sheetGid, t.externalId).where(sql`${t.externalId} is not null`),
  index("lead_ws_status_idx").on(t.workspaceId, t.status),
  index("lead_owner_next_idx").on(t.ownerId, t.nextFollowUpAt),
  index("lead_acquired_idx").on(t.workspaceId, t.acquiredAt),
  index("lead_phone_idx").on(t.workspaceId, t.phoneNorm),
  index("lead_email_idx").on(t.workspaceId, t.emailNorm),
]);

export const leadActivity = pgTable("lead_activity", {
  id: id(),
  leadId: uuid("lead_id").notNull().references(() => lead.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull(),
  type: activityTypeEnum("type").notNull(),
  actorId: text("actor_id"), // null = system
  summary: text("summary"),
  data: jsonb("data").notNull().default({}),
  idempotencyKey: text("idempotency_key"), // prevents duplicate rows on retries
  occurredAt: ts("occurred_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("activity_idem_uq").on(t.leadId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  index("activity_lead_idx").on(t.leadId, t.occurredAt),
  index("activity_ws_time_idx").on(t.workspaceId, t.occurredAt),
]);

/* ---------- Follow-up engine ---------- */
export const followUpTask = pgTable("follow_up_task", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  leadId: uuid("lead_id").notNull().references(() => lead.id, { onDelete: "cascade" }),
  step: followUpStepEnum("step").notNull(),
  ownerId: uuid("owner_id").references(() => workspaceMember.id, { onDelete: "set null" }),
  dueAt: ts("due_at").notNull(),
  status: taskStatusEnum("status").notNull().default("pending"),
  // Overdue is derived (pending && dueAt < now); first miss is persisted for history
  firstMissedAt: ts("first_missed_at"),
  escalatedAt: ts("escalated_at"),
  completedAt: ts("completed_at"),
  completedBy: text("completed_by"),
  result: text("result"),
  // Makes ingest/cron idempotent: one task per lead+step+slot
  dedupeKey: text("dedupe_key").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("task_dedupe_uq").on(t.dedupeKey),
  index("task_owner_due_idx").on(t.ownerId, t.status, t.dueAt),
  index("task_ws_due_idx").on(t.workspaceId, t.status, t.dueAt),
  index("task_lead_idx").on(t.leadId),
]);

export const notification = pgTable("notification", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  memberId: uuid("member_id").notNull().references(() => workspaceMember.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // due | advance | overdue | escalation | briefing | assignment
  title: text("title").notNull(),
  body: text("body"),
  leadId: uuid("lead_id"),
  taskId: uuid("task_id"),
  dedupeKey: text("dedupe_key").notNull(),
  readAt: ts("read_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("notif_dedupe_uq").on(t.dedupeKey),
  index("notif_member_idx").on(t.memberId, t.readAt, t.createdAt),
]);

export const auditLog = pgTable("audit_log", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  data: jsonb("data").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("audit_ws_idx").on(t.workspaceId, t.createdAt)]);

export const aiInsight = pgTable("ai_insight", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  periodStart: ts("period_start").notNull(),
  periodEnd: ts("period_end").notNull(),
  metrics: jsonb("metrics").notNull(),
  summary: text("summary").notNull(),
  model: text("model"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
