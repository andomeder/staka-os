import type { Machine } from "../db/schema.ts";

type Entry = {
  status: Machine["status"];
  expiresAt: number;
};

/** Short TTL cache for machine status re-checks on authenticated requests. */
export class MachineStatusCache {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly ttlMs = 60_000) {}

  get(machineId: string, now = Date.now()): Machine["status"] | undefined {
    const entry = this.map.get(machineId);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(machineId);
      return undefined;
    }
    return entry.status;
  }

  set(machineId: string, status: Machine["status"], now = Date.now()): void {
    this.map.set(machineId, { status, expiresAt: now + this.ttlMs });
  }

  invalidate(machineId: string): void {
    this.map.delete(machineId);
  }

  clear(): void {
    this.map.clear();
  }
}
