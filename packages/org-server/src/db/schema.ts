import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["admin", "staff"]);
export const userStatusEnum = pgEnum("user_status", [
  "invited",
  "active",
  "suspended",
]);
export const machineStatusEnum = pgEnum("machine_status", [
  "pending",
  "approved",
  "active",
  "suspended",
  "revoked",
]);
export const provisionFlowEnum = pgEnum("provision_flow", ["admin", "self"]);
export const codeFlowEnum = pgEnum("code_flow", ["admin", "self"]);
export const usageEventTypeEnum = pgEnum("usage_event_type", [
  "activation_requested",
  "activation_approved",
  "activation_denied",
  "heartbeat",
  "token_issued",
  "nonce_issued",
  "admin_action",
  "admin_read_pii",
  "user_authenticated_self_provision",
  "config_pull",
]);

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    employeeId: text("employee_id").notNull(),
    email: text("email"),
    displayName: text("display_name").notNull(),
    role: userRoleEnum("role").notNull(),
    status: userStatusEnum("status").notNull().default("invited"),
    passwordHash: text("password_hash"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("users_employee_id_uidx").on(t.employeeId),
    uniqueIndex("users_email_uidx")
      .on(t.email)
      .where(sql`${t.email} IS NOT NULL`),
  ],
);

export const activationCodes = pgTable(
  "activation_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    codeHash: text("code_hash").notNull(),
    codeDisplay: text("code_display").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    uses: integer("uses").notNull().default(0),
    flow: codeFlowEnum("flow").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("activation_codes_code_hash_uidx").on(t.codeHash),
    index("activation_codes_user_id_idx").on(t.userId),
  ],
);

export const machines = pgTable(
  "machines",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    hardwareId: text("hardware_id").notNull(),
    hwidHash: text("hwid_hash").notNull(),
    hwidDisplay: text("hwid_display").notNull(),
    hwidComponents: jsonb("hwid_components").notNull().$type<Record<string, string>>(),
    hostname: text("hostname").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    enrollmentCodeId: uuid("enrollment_code_id")
      .notNull()
      .references(() => activationCodes.id),
    status: machineStatusEnum("status").notNull().default("pending"),
    enrollmentNonceHash: text("enrollment_nonce_hash"),
    provisionFlow: provisionFlowEnum("provision_flow").notNull(),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("machines_hardware_id_uidx").on(t.hardwareId),
    index("machines_status_idx").on(t.status),
    index("machines_user_id_idx").on(t.userId),
    index("machines_last_heartbeat_at_idx").on(t.lastHeartbeatAt),
    index("machines_hwid_hash_idx").on(t.hwidHash),
  ],
);

export const usageLogs = pgTable(
  "usage_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    eventType: usageEventTypeEnum("event_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("usage_logs_machine_created_idx").on(t.machineId, t.createdAt),
  ],
);

export const adminAuditLog = pgTable("admin_audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  prevHash: text("prev_hash").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;
export type ActivationCode = typeof activationCodes.$inferSelect;
export type NewActivationCode = typeof activationCodes.$inferInsert;
export type UsageLog = typeof usageLogs.$inferSelect;
export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
