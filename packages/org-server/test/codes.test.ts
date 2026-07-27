import { describe, expect, test } from "bun:test";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../src/lib/codes.ts";

describe("codes", () => {
  test("generation format", () => {
    const code = generateEnrollmentCode();
    expect(code).toMatch(/^STAKA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("hashing is stable and case-insensitive", () => {
    const a = hashEnrollmentCode("STAKA-AAAA-BBBB-CCCC-DDDD");
    const b = hashEnrollmentCode("staka-aaaa-bbbb-cccc-dddd");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("mask keeps prefix and suffix", () => {
    const masked = maskEnrollmentCode("STAKA-AAAA-BBBB-CCCC-DDDD");
    expect(masked.startsWith("STAKA-AAAA")).toBe(true);
    expect(masked.endsWith("DDDD")).toBe(true);
  });
});
