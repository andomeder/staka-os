export type AdminSession = {
  userId: string;
  employeeId: string;
  expiresAt: number;
};

/** Single-process admin session store keyed by JWT jti. Restart clears sessions.
 *  Not multi-instance safe: each process has its own map. */
export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSession>();

  create(input: {
    userId: string;
    employeeId: string;
    expiresAt: number;
    jti?: string;
  }): string {
    this.gc();
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

  revokeUser(userId: string): number {
    let n = 0;
    for (const [jti, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(jti);
        n += 1;
      }
    }
    return n;
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

  private gc(now = Date.now()): void {
    if (this.sessions.size < 256) return;
    for (const [jti, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(jti);
    }
  }
}
