export type AdminFlashPayload = {
  message?: string;
  nonce?: string;
  code?: string;
  hwidJson?: string;
};

/** One-shot PRG flash store keyed by admin jti. Restart clears. */
export class AdminFlashStore {
  private readonly entries = new Map<
    string,
    { payload: AdminFlashPayload; expiresAt: number }
  >();

  set(jti: string, payload: AdminFlashPayload, ttlMs = 5 * 60_000): void {
    this.entries.set(jti, {
      payload,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /** Consume flash for jti (read-once). */
  take(jti: string, now = Date.now()): AdminFlashPayload | null {
    const row = this.entries.get(jti);
    if (!row) return null;
    this.entries.delete(jti);
    if (row.expiresAt <= now) return null;
    return row.payload;
  }

  reset(): void {
    this.entries.clear();
  }
}
