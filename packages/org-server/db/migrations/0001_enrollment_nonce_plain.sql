ALTER TABLE "machines" ADD COLUMN "enrollment_nonce_plain" text;
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
  enrollment_nonce_plain,
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
  enrollment_nonce_plain,
  approved_at,
  approved_by,
  last_heartbeat_at,
  updated_at
) ON machines TO staka_app;
