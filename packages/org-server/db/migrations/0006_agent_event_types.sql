ALTER TYPE "public"."usage_event_type" ADD VALUE IF NOT EXISTS 'agent_action';--> statement-breakpoint
ALTER TYPE "public"."usage_event_type" ADD VALUE IF NOT EXISTS 'agent_error';--> statement-breakpoint
ALTER TYPE "public"."usage_event_type" ADD VALUE IF NOT EXISTS 'skill_invoked';
