CREATE TYPE "public"."activity_type" AS ENUM('imported', 'created', 'assigned', 'status_changed', 'contact_attempt', 'contacted', 'no_answer', 'note', 'followup_completed', 'followup_rescheduled', 'milestone', 'closed', 'reopened', 'escalated', 'merged', 'synced');--> statement-breakpoint
CREATE TYPE "public"."follow_up_step" AS ENUM('contact_started', 'h24', 'h48', 'final', 'completed');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'interested', 'proposal_sent', 'converted', 'not_interested', 'no_response', 'cold');--> statement-breakpoint
CREATE TYPE "public"."lead_outcome" AS ENUM('converted', 'not_interested', 'no_response', 'dropped', 'duplicate', 'invalid', 'other');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('admin', 'manager', 'bd', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('read_only', 'two_way');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'completed', 'rescheduled', 'cancelled');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_insight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"metrics" jsonb NOT NULL,
	"summary" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"step" "follow_up_step" NOT NULL,
	"owner_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"first_missed_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"result" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_raw" text,
	"phone_norm" text,
	"email" text,
	"email_norm" text,
	"source" text,
	"campaign" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"follow_up_step" "follow_up_step" DEFAULT 'contact_started' NOT NULL,
	"outcome" "lead_outcome",
	"closure_reason" text,
	"closed_at" timestamp with time zone,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"owner_id" uuid,
	"backup_owner_id" uuid,
	"app_downloaded_at" timestamp with time zone,
	"referral_shared_at" timestamp with time zone,
	"card_purchased_at" timestamp with time zone,
	"spending_started_at" timestamp with time zone,
	"acquired_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_contacted_at" timestamp with time zone,
	"last_contacted_at" timestamp with time zone,
	"next_follow_up_at" timestamp with time zone,
	"follow_up_attempts" integer DEFAULT 0 NOT NULL,
	"last_result" text,
	"converted_at" timestamp with time zone,
	"connection_id" uuid,
	"sheet_gid" text,
	"external_id" text,
	"source_row_hash" text,
	"source_url" text,
	"source_raw" jsonb,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"merged_into_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "activity_type" NOT NULL,
	"actor_id" text,
	"summary" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"lead_id" uuid,
	"task_id" uuid,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "spreadsheet_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"title" text,
	"mode" "sync_mode" DEFAULT 'read_only' NOT NULL,
	"encrypted_refresh_token" text,
	"google_email" text,
	"healthy" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"last_successful_sync_at" timestamp with time zone,
	"drive_channel_id" text,
	"drive_channel_resource_id" text,
	"drive_channel_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_conflict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"lead_id" uuid,
	"field" text NOT NULL,
	"sheet_value" text,
	"crm_value" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"rows_seen" integer DEFAULT 0 NOT NULL,
	"rows_created" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worksheet_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"sheet_gid" text NOT NULL,
	"sheet_title" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"header_row" integer DEFAULT 1 NOT NULL,
	"column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value_maps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"identity_strategy" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Karachi' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" DEFAULT 'bd' NOT NULL,
	"display_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"capacity" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD CONSTRAINT "follow_up_task_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD CONSTRAINT "follow_up_task_owner_id_workspace_member_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."workspace_member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_owner_id_workspace_member_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."workspace_member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_backup_owner_id_workspace_member_id_fk" FOREIGN KEY ("backup_owner_id") REFERENCES "public"."workspace_member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_connection_id_spreadsheet_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."spreadsheet_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activity" ADD CONSTRAINT "lead_activity_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_member_id_workspace_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."workspace_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spreadsheet_connection" ADD CONSTRAINT "spreadsheet_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflict" ADD CONSTRAINT "sync_conflict_connection_id_spreadsheet_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."spreadsheet_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_connection_id_spreadsheet_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."spreadsheet_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksheet_mapping" ADD CONSTRAINT "worksheet_mapping_connection_id_spreadsheet_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."spreadsheet_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_ws_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dedupe_uq" ON "follow_up_task" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "task_owner_due_idx" ON "follow_up_task" USING btree ("owner_id","status","due_at");--> statement-breakpoint
CREATE INDEX "task_ws_due_idx" ON "follow_up_task" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "task_lead_idx" ON "follow_up_task" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_source_uq" ON "lead" USING btree ("connection_id","sheet_gid","external_id") WHERE "lead"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "lead_ws_status_idx" ON "lead" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "lead_owner_next_idx" ON "lead" USING btree ("owner_id","next_follow_up_at");--> statement-breakpoint
CREATE INDEX "lead_acquired_idx" ON "lead" USING btree ("workspace_id","acquired_at");--> statement-breakpoint
CREATE INDEX "lead_phone_idx" ON "lead" USING btree ("workspace_id","phone_norm");--> statement-breakpoint
CREATE INDEX "lead_email_idx" ON "lead" USING btree ("workspace_id","email_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_idem_uq" ON "lead_activity" USING btree ("lead_id","idempotency_key") WHERE "lead_activity"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "activity_lead_idx" ON "lead_activity" USING btree ("lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_ws_time_idx" ON "lead_activity" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notif_dedupe_uq" ON "notification" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notif_member_idx" ON "notification" USING btree ("member_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sc_ws_sheet_uq" ON "spreadsheet_connection" USING btree ("workspace_id","spreadsheet_id");--> statement-breakpoint
CREATE INDEX "sync_job_conn_idx" ON "sync_job" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wsm_conn_gid_uq" ON "worksheet_mapping" USING btree ("connection_id","sheet_gid");--> statement-breakpoint
CREATE UNIQUE INDEX "wm_ws_user_uq" ON "workspace_member" USING btree ("workspace_id","user_id");