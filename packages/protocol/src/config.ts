import { z } from "zod";

export const ConfigResponse = z.object({
  version: z.literal(1),
  org_name: z.string(),
  features: z.object({
    skills_sync: z.boolean(),
    memory_sync: z.boolean(),
  }),
  model: z.object({
    provider: z.string().nullable(),
    model_id: z.string().nullable(),
    base_url: z.string().nullable(),
  }),
  skill_pack_url: z.string().nullable(),
  skill_pack_hash: z.string().nullable(),
});

export type ConfigResponse = z.infer<typeof ConfigResponse>;

export const MachineInfo = z.object({
  id: z.string().uuid(),
  hostname: z.string(),
  status: z.enum(["pending", "approved", "active", "suspended", "revoked"]),
  provision_flow: z.enum(["admin", "self"]),
  first_seen_at: z.string(),
  last_heartbeat_at: z.string().nullable(),
});

export type MachineInfo = z.infer<typeof MachineInfo>;

export const MachineUserInfo = z.object({
  id: z.string().uuid(),
  employee_id: z.string(),
  display_name: z.string(),
  email: z.string().nullable(),
  status: z.enum(["invited", "active", "suspended"]),
});

export type MachineUserInfo = z.infer<typeof MachineUserInfo>;

export const MachineMeResponse = z.object({
  machine: MachineInfo,
  user: MachineUserInfo,
});

export type MachineMeResponse = z.infer<typeof MachineMeResponse>;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text_delta"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_start"),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_call_end"),
    name: z.string(),
    result_summary: z.string(),
  }),
  z.object({
    type: z.literal("skill_loaded"),
    name: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    tokens_in: z.number().optional(),
    tokens_out: z.number().optional(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEvent>;
