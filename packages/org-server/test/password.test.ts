import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../src/lib/password.ts";

describe("password", () => {
  test("hash/verify roundtrip", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith("$argon2")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});
