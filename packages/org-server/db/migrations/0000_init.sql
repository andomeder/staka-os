CREATE TYPE "public"."code_flow" AS ENUM('admin', 'self');--> statement-breakpoint
CREATE TYPE "public"."machine_status" AS ENUM('pending', 'approved', 'active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."provision_flow" AS ENUM('admin', 'self');--> statement-breakpoint
CREATE TYPE "public"."usage_event_type" AS ENUM('activation_requested', 'activation_approved', 'activation_denied', 'heartbeat', 'token_issued', 'nonce_issued', 'admin_action', 'admin_read_pii', 'user_authenticated_self_provision', 'config_pull');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'staff');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "activation_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" text NOT NULL,
	"code_display" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"flow" "code_flow" NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"hardware_id" text NOT NULL,
	"hwid_hash" text NOT NULL,
	"hwid_display" text NOT NULL,
	"hwid_components" jsonb NOT NULL,
	"hostname" text NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_code_id" uuid NOT NULL,
	"status" "machine_status" DEFAULT 'pending' NOT NULL,
	"enrollment_nonce_hash" text,
	"provision_flow" "provision_flow" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"event_type" "usage_event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"employee_id" text NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activation_codes" ADD CONSTRAINT "activation_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_codes" ADD CONSTRAINT "activation_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_enrollment_code_id_activation_codes_id_fk" FOREIGN KEY ("enrollment_code_id") REFERENCES "public"."activation_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_codes_code_hash_uidx" ON "activation_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "activation_codes_user_id_idx" ON "activation_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_hardware_id_uidx" ON "machines" USING btree ("hardware_id");--> statement-breakpoint
CREATE INDEX "machines_status_idx" ON "machines" USING btree ("status");--> statement-breakpoint
CREATE INDEX "machines_user_id_idx" ON "machines" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "machines_last_heartbeat_at_idx" ON "machines" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "machines_hwid_hash_idx" ON "machines" USING btree ("hwid_hash");--> statement-breakpoint
CREATE INDEX "usage_logs_machine_created_idx" ON "usage_logs" USING btree ("machine_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_employee_id_uidx" ON "users" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree ("email") WHERE "users"."email" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION staka_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION staka_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER machines_set_updated_at
BEFORE UPDATE ON machines
FOR EACH ROW EXECUTE FUNCTION staka_set_updated_at();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staka_app') THEN
    CREATE ROLE staka_app NOINHERIT LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staka_admin') THEN
    CREATE ROLE staka_admin NOINHERIT LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO staka_app, staka_admin', current_database());
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO staka_app, staka_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON users, activation_codes TO staka_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON usage_logs TO staka_app;
--> statement-breakpoint
GRANT INSERT ON machines TO staka_app;
--> statement-breakpoint
GRANT SELECT (
  id,
  hardware_id,
  hwid_hash,
  hwid_display,
  hostname,
  user_id,
  enrollment_code_id,
  status,
  enrollment_nonce_hash,
  provision_flow,
  first_seen_at,
  approved_at,
  approved_by,
  last_heartbeat_at,
  created_at,
  updated_at
) ON machines TO staka_app;
--> statement-breakpoint
GRANT UPDATE (
  hwid_hash,
  hwid_display,
  hostname,
  status,
  enrollment_nonce_hash,
  approved_at,
  approved_by,
  last_heartbeat_at,
  updated_at
) ON machines TO staka_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON admin_audit_log TO staka_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON admin_audit_log FROM staka_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staka_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON users, activation_codes, machines, usage_logs TO staka_admin;
--> statement-breakpoint
GRANT SELECT, INSERT ON admin_audit_log TO staka_admin;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON admin_audit_log FROM staka_admin;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staka_admin;
