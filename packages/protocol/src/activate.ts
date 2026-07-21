import { z } from "zod";

export const Hostname = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-zA-Z0-9-]{1,63}$/, "invalid hostname");

export const HwidComponents = z
  .object({
    product_uuid: z.string().min(1),
    board_serial: z.string(),
    product_name: z.string(),
    cpu_id: z.string(),
  })
  .strict();

export const ProvisionFlow = z.enum(["admin", "self"]);

export const MachineStatus = z.enum([
  "pending",
  "approved",
  "active",
  "suspended",
  "revoked",
]);

export const SelfAuthenticateRequest = z
  .object({
    employee_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9-]+$/, "invalid employee_id"),
    password: z.string().min(1).max(1024),
    enrollment_code: z.string().min(1).max(128),
  })
  .strict();

export const SelfAuthenticateResponse = z
  .object({
    self_provision_token: z.string().min(1),
    expires_at: z.string().datetime(),
  })
  .strict();

export const EnrollRequestAdmin = z
  .object({
    enrollment_code: z.string().min(1).max(128),
    hardware_id: z.string().min(1).max(128),
    hwid_hash: z.string().min(1).max(128),
    hwid_components: HwidComponents,
    hostname: Hostname,
    flow: z.literal("admin"),
  })
  .strict();

export const EnrollRequestSelf = z
  .object({
    enrollment_code: z.string().min(1).max(128),
    self_provision_token: z.string().min(1),
    hardware_id: z.string().min(1).max(128),
    hwid_hash: z.string().min(1).max(128),
    hwid_components: HwidComponents,
    hostname: Hostname,
    flow: z.literal("self"),
  })
  .strict();

export const EnrollRequest = z.discriminatedUnion("flow", [
  EnrollRequestAdmin,
  EnrollRequestSelf,
]);

export const EnrollResponse = z
  .object({
    machine_id: z.string().uuid(),
    status: MachineStatus,
    poll_interval: z.number().int().positive(),
  })
  .strict();

export const StatusResponse = z
  .object({
    status: MachineStatus,
    enrollment_nonce: z.string().optional(),
  })
  .strict();

export const TokenRequest = z
  .object({
    machine_id: z.string().uuid(),
    enrollment_nonce: z.string().min(1),
  })
  .strict();

export const TokenResponse = z
  .object({
    machine_jwt: z.string().min(1),
    expires_at: z.string().datetime(),
  })
  .strict();

export const HeartbeatRequest = z
  .object({
    metrics: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const HeartbeatResponse = z
  .object({
    ok: z.literal(true),
    status: MachineStatus,
  })
  .strict();

export type HwidComponents = z.infer<typeof HwidComponents>;
export type ProvisionFlow = z.infer<typeof ProvisionFlow>;
export type MachineStatus = z.infer<typeof MachineStatus>;
export type SelfAuthenticateRequest = z.infer<typeof SelfAuthenticateRequest>;
export type SelfAuthenticateResponse = z.infer<typeof SelfAuthenticateResponse>;
export type EnrollRequest = z.infer<typeof EnrollRequest>;
export type EnrollResponse = z.infer<typeof EnrollResponse>;
export type StatusResponse = z.infer<typeof StatusResponse>;
export type TokenRequest = z.infer<typeof TokenRequest>;
export type TokenResponse = z.infer<typeof TokenResponse>;
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;
