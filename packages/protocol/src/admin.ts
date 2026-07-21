import { z } from "zod";

export const EmployeeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/, "invalid employee_id");

export const DisplayName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f<>]+$/, "invalid display_name");

export const Email = z.email().max(320);

export const UserRole = z.enum(["admin", "staff"]);
export const UserStatus = z.enum(["invited", "active", "suspended"]);
export const CodeFlow = z.enum(["admin", "self"]);

export const CreateUserRequest = z
  .object({
    employee_id: EmployeeId,
    display_name: DisplayName,
    role: UserRole,
    initial_password: z.string().min(8).max(1024).optional(),
    email: Email.optional(),
  })
  .strict();

export const CreateUserResponse = z
  .object({
    user_id: z.string().uuid(),
    employee_id: EmployeeId,
    status: UserStatus,
  })
  .strict();

export const CreateCodeRequest = z
  .object({
    user_id: z.string().uuid(),
    flow: CodeFlow,
    max_uses: z.number().int().positive().max(1000).optional(),
    expires_at: z.string().datetime().optional(),
  })
  .strict();

export const CreateCodeResponse = z
  .object({
    id: z.string().uuid(),
    code: z.string().min(1),
    code_display: z.string().min(1),
    flow: CodeFlow,
    expires_at: z.string().datetime(),
    max_uses: z.number().int().positive(),
  })
  .strict();

export const AdminLoginRequest = z
  .object({
    employee_id: EmployeeId,
    password: z.string().min(1).max(1024),
  })
  .strict();

export const AdminLoginResponse = z
  .object({
    admin_jwt: z.string().min(1),
    expires_at: z.string().datetime(),
  })
  .strict();

export const SetPasswordRequest = z
  .object({
    password: z.string().min(8).max(1024),
  })
  .strict();

export const ReportsSummary = z
  .object({
    machines_by_status: z.record(z.string(), z.number().int().nonnegative()),
    recent_activations: z.number().int().nonnegative(),
    stale_machines: z.number().int().nonnegative(),
  })
  .strict();

export type EmployeeId = z.infer<typeof EmployeeId>;
export type DisplayName = z.infer<typeof DisplayName>;
export type UserRole = z.infer<typeof UserRole>;
export type UserStatus = z.infer<typeof UserStatus>;
export type CodeFlow = z.infer<typeof CodeFlow>;
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;
export type CreateUserResponse = z.infer<typeof CreateUserResponse>;
export type CreateCodeRequest = z.infer<typeof CreateCodeRequest>;
export type CreateCodeResponse = z.infer<typeof CreateCodeResponse>;
export type AdminLoginRequest = z.infer<typeof AdminLoginRequest>;
export type AdminLoginResponse = z.infer<typeof AdminLoginResponse>;
export type SetPasswordRequest = z.infer<typeof SetPasswordRequest>;
export type ReportsSummary = z.infer<typeof ReportsSummary>;
