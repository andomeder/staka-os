CREATE TABLE "skill_packs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"skill_count" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_packs" ADD CONSTRAINT "skill_packs_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_packs_version_uidx" ON "skill_packs" USING btree ("version");--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON skill_packs TO staka_admin;--> statement-breakpoint
GRANT SELECT ON skill_packs TO staka_app;
