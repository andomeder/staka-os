export type AdminSession = {
  userId: string;
  employeeId: string;
  expiresAt: number;
};

/** Single-process admin session store keyed by JWT jti. Restart clears sessions. */
export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSession>();

  create(input: {
    userId: string;
    employeeId: string;
    expiresAt: number;
    jti?: string;
  }): string {
    const jti = input.jti ?? crypto.randomUUID();
    this.sessions.set(jti, {
      userId: input.userId,
      employeeId: input.employeeId,
      expiresAt: input.expiresAt,
    });
    return jti;
  }

  get(jti: string, now = Date.now()): AdminSession | null {
    const row = this.sessions.get(jti);
    if (!row) return null;
    if (row.expiresAt <= now) {
      this.sessions.delete(jti);
      return null;
    }
    return row;
  }

  revoke(jti: string): boolean {
    return this.sessions.delete(jti);
  }

  rotate(
    oldJti: string,
    input: { userId: string; employeeId: string; expiresAt: number },
  ): string | null {
    const existing = this.get(oldJti);
    if (!existing) return null;
    if (existing.userId !== input.userId) return null;
    this.sessions.delete(oldJti);
    return this.create(input);
  }

  reset(): void {
    this.sessions.clear();
  }
}
