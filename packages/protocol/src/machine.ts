import { z } from "zod";

/** Machine JWT claims. No hwid_hash - middleware re-checks DB status. */
export const MachineJwtClaims = z
  .object({
    sub: z.string().uuid(),
    typ: z.literal("machine"),
    iat: z.number().int(),
    exp: z.number().int(),
    kid: z.string().min(1),
  })
  .strict();

/** Short-lived self-provision token claims (Flow B). */
export const SelfProvisionClaims = z
  .object({
    typ: z.literal("self_provision"),
    user_id: z.string().uuid(),
    code_id: z.string().uuid(),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

export const AdminJwtClaims = z
  .object({
    sub: z.string().uuid(),
    role: z.literal("admin"),
    employee_id: z.string().min(1),
    iat: z.number().int(),
    exp: z.number().int(),
    kid: z.string().min(1),
  })
  .strict();

export type MachineJwtClaims = z.infer<typeof MachineJwtClaims>;
export type SelfProvisionClaims = z.infer<typeof SelfProvisionClaims>;
export type AdminJwtClaims = z.infer<typeof AdminJwtClaims>;
