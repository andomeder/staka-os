import pino from "pino";

export function createLogger(level = "info") {
  return pino({
    level,
    base: { service: "staka-org-server" },
    redact: {
      paths: [
        "password",
        "password_hash",
        "enrollment_code",
        "self_provision_token",
        "machine_jwt",
        "admin_jwt",
        "hwid_components",
        "req.headers.authorization",
      ],
      remove: true,
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
