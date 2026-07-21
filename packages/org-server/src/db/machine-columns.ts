import { getTableColumns } from "drizzle-orm";
import { machines } from "./schema.ts";

const all = getTableColumns(machines);

/** Columns `staka_app` may SELECT (excludes hwid_components PII). */
export const appMachineColumns = {
  id: all.id,
  hardwareId: all.hardwareId,
  hwidHash: all.hwidHash,
  hwidDisplay: all.hwidDisplay,
  hostname: all.hostname,
  userId: all.userId,
  enrollmentCodeId: all.enrollmentCodeId,
  status: all.status,
  enrollmentNonceHash: all.enrollmentNonceHash,
  enrollmentNoncePlain: all.enrollmentNoncePlain,
  provisionFlow: all.provisionFlow,
  firstSeenAt: all.firstSeenAt,
  approvedAt: all.approvedAt,
  approvedBy: all.approvedBy,
  lastHeartbeatAt: all.lastHeartbeatAt,
  createdAt: all.createdAt,
  updatedAt: all.updatedAt,
};

export type AppMachine = {
  [K in keyof typeof appMachineColumns]: (typeof machines.$inferSelect)[K];
};
