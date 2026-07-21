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

GRANT USAGE ON SCHEMA public TO staka_app, staka_admin;

GRANT SELECT, INSERT, UPDATE ON
  users,
  activation_codes,
  usage_logs
TO staka_app;

GRANT INSERT, UPDATE ON machines TO staka_app;

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

GRANT SELECT, INSERT ON admin_audit_log TO staka_app;
REVOKE UPDATE, DELETE ON admin_audit_log FROM staka_app;
REVOKE ALL ON admin_audit_log FROM PUBLIC;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staka_app;

GRANT SELECT, INSERT, UPDATE ON
  users,
  activation_codes,
  machines,
  usage_logs,
  admin_audit_log
TO staka_admin;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staka_admin;
