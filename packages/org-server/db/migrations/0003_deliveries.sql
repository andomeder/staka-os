ALTER TYPE "usage_event_type" ADD VALUE IF NOT EXISTS 'agent_action';--> statement-breakpoint
ALTER TYPE "usage_event_type" ADD VALUE IF NOT EXISTS 'agent_error';--> statement-breakpoint
ALTER TYPE "usage_event_type" ADD VALUE IF NOT EXISTS 'skill_invoked';--> statement-breakpoint
ALTER TYPE "usage_event_type" ADD VALUE IF NOT EXISTS 'agent_file_read';--> statement-breakpoint
ALTER TYPE "usage_event_type" ADD VALUE IF NOT EXISTS 'delivery_created';--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"machine_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"artifact_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_created_idx" ON "deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "deliveries_machine_idx" ON "deliveries" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "deliveries_to_user_idx" ON "deliveries" USING btree ("to_user_id");--> statement-breakpoint
GRANT SELECT, INSERT ON deliveries TO staka_app;--> statement-breakpoint
GRANT SELECT ON deliveries TO staka_admin;
