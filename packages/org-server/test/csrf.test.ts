import { describe, expect, test } from "bun:test";
import { createCsrfSigner } from "../src/lib/csrf.ts";

describe("csrf", () => {
  test("mint and verify pair", () => {
    const csrf = createCsrfSigner("test-secret-at-least-16");
    const { token } = csrf.mint();
    expect(csrf.verify(token)).toBe(true);
    expect(csrf.verifyPair(token, token)).toBe(true);
    expect(csrf.verifyPair(token, token + "x")).toBe(false);
    expect(csrf.verifyPair(undefined, token)).toBe(false);
  });

  test("rejects expired token", () => {
    const csrf = createCsrfSigner("test-secret-at-least-16");
    const { token, expiresAt } = csrf.mint();
    expect(csrf.verify(token, expiresAt + 1)).toBe(false);
  });
});
