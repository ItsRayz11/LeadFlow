CREATE TYPE "public"."contact_channel" AS ENUM('call', 'whatsapp', 'email', 'sms', 'other');--> statement-breakpoint
CREATE TYPE "public"."interaction_outcome" AS ENUM('reached', 'no_answer', 'interested', 'callback_requested', 'converted', 'not_interested', 'dropped');--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'edited';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'scheduled';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'reassigned';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'reopened_task';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'invited';--> statement-breakpoint
CREATE TABLE "identity_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"member_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "invite_ws_email_uq";--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "priority" "priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "channel" "contact_channel";--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "outcome" "interaction_outcome";--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "anchor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "lead_activity" ADD COLUMN "channel" "contact_channel";--> statement-breakpoint
ALTER TABLE "lead_activity" ADD COLUMN "outcome" "interaction_outcome";--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "singleton" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_alias" ADD CONSTRAINT "identity_alias_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_alias" ADD CONSTRAINT "identity_alias_member_id_workspace_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."workspace_member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alias_ws_alias_uq" ON "identity_alias" USING btree ("workspace_id",lower("alias"));--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_uq" ON "notification_delivery" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "delivery_due_idx" ON "notification_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_one_pending_uq" ON "follow_up_task" USING btree ("lead_id") WHERE "follow_up_task"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "invite_email_idx" ON "invite" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_hash_uq" ON "invite" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_singleton_unique" UNIQUE("singleton");