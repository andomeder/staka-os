CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"custom_id" text NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"doc_type" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid,
	"engine_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_custom_id_uidx" ON "kb_documents" USING btree ("custom_id");--> statement-breakpoint
CREATE INDEX "kb_documents_source_idx" ON "kb_documents" USING btree ("source");--> statement-breakpoint
CREATE INDEX "kb_documents_deleted_at_idx" ON "kb_documents" USING btree ("deleted_at");;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kb_documents TO staka_admin;--> statement-breakpoint
GRANT SELECT ON kb_documents TO staka_app;
